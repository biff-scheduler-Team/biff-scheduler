import {test, expect} from '@playwright/test';
import {ready, storage} from './helpers';

test('React account entry preserves guest data and opens the existing login flow', async ({page}) => {
  await page.route('**/api/account/me',route=>route.fulfill({status:401,json:{error:'UNAUTHENTICATED'}}));
  await ready(page,'/schedule?date=2026-10-07');
  await expect(page.locator('#account-sync-status')).toHaveText('数据保存在这台设备');
  await page.locator('[data-grid-code="008"]').click();
  const before=await storage(page);
  await page.getByRole('button',{name:'登录 IFFDAY',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'IFFDAY 账号',exact:true});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button',{name:'使用 IFFDAY 登录',exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  expect(await storage(page)).toEqual(before);
  await page.reload();
  await expect(page.locator('[data-grid-code="008"]')).toHaveAttribute('aria-pressed','true');
});

test('account profile editing and automatic schedule sync remain connected to the React app', async ({page}) => {
  const id='user_00000000000000000000000001';
  const account={user:{id,email:'viewer@example.com',emailVerified:true},profile:{userId:id,displayName:'观众',bio:'',website:'',avatarUrl:null,updatedAt:'2026-09-13T00:00:00Z',version:1}};
  let records: Record<string,string>={};
  let revision=0;
  await page.route('**/api/account/me',route=>route.fulfill({json:account}));
  await page.route('**/api/account/sync/biff-2026',async route=>{
    if(route.request().method()==='PUT'){records=route.request().postDataJSON().records;revision++;await route.fulfill({json:{revision}});}
    else await route.fulfill({json:{subject:id,revision,records,updatedAt:0,importedAt:null}});
  });
  await page.route('**/api/account/profile',async route=>{
    const patch=route.request().postDataJSON();account.profile.displayName=patch.displayName;account.profile.bio=patch.bio;account.profile.version++;
    await route.fulfill({json:{version:account.profile.version}});
  });
  await ready(page,'/schedule?date=2026-10-07');
  await expect(page.locator('#account-btn')).toHaveText('观众');
  await expect(page.locator('#account-sync-status')).toHaveText('已同步');
  await page.locator('[data-grid-code="008"]').click();
  await expect.poll(()=>Object.values(records).some(value=>value.includes('008'))).toBe(true);
  await page.locator('#account-btn').click();
  const dialog=page.getByRole('dialog',{name:'IFFDAY 账号',exact:true});
  await dialog.getByLabel('显示名称',{exact:true}).fill('新观众');
  await dialog.getByRole('button',{name:'保存个人资料',exact:true}).click();
  await expect(page.locator('#account-btn')).toHaveText('新观众');
});


test('legacy topbar shows login entry and the same guest session status', async ({page}) => {
  await page.route('**/api/account/me',route=>route.fulfill({status:401,json:{error:'UNAUTHENTICATED'}}));
  await page.goto('/legacy/');
  await expect(page.locator('#topbar')).toBeVisible();
  await expect(page.locator('#account-btn')).toHaveText('登录 IFFDAY');
  await expect(page.locator('#account-sync-status')).toHaveText('数据保存在这台设备');
});

test('legacy shows the authenticated display name from the shared session cookie path', async ({page}) => {
  const id='user_00000000000000000000000001';
  const account={user:{id,email:'viewer@example.com',emailVerified:true},profile:{userId:id,displayName:'观众',bio:'',website:'',avatarUrl:null,updatedAt:'2026-09-13T00:00:00Z',version:1}};
  await page.route('**/api/account/me',route=>route.fulfill({json:account}));
  await page.route('**/api/account/sync/biff-2026',async route=>{
    if(route.request().method()==='PUT') await route.fulfill({json:{revision:1}});
    else await route.fulfill({json:{subject:id,revision:0,records:{},updatedAt:0,importedAt:null}});
  });
  await ready(page,'/schedule?date=2026-10-07');
  await expect(page.locator('#account-btn')).toHaveText('观众');
  await page.goto('/legacy/');
  await expect(page.locator('#account-btn')).toHaveText('观众');
  await expect(page.locator('#account-sync-status')).toHaveText(/已同步|正在同步|有待同步数据|数据保存在这台设备/);
});
