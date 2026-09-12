import {describe, expect, it} from 'vitest';
import {screeningLanes, captureVerticalAnchor, restoreVerticalAnchor, type VerticalGeometry} from '../src/app/vertical-schedule';
import type {Screening} from '../src/types';

const show = (code: string, start: string, end: string) => ({code, start_time: start, end_time: end, is_gv: false} as Screening);

describe('vertical schedule', () => {
  it('keeps simultaneous screenings accessible and returns to full width after the overlap group', () => {
    const lanes = screeningLanes([show('d','12:00','13:00'), show('a','09:00','11:00'), show('b','09:30','10:00'), show('c','10:00','11:30')]);
    expect(lanes.get('a')).toEqual({lane:0,count:2});
    expect(lanes.get('b')).toEqual({lane:1,count:2});
    expect(lanes.get('c')).toEqual({lane:1,count:2});
    expect(lanes.get('d')).toEqual({lane:0,count:1});
  });
  it('handles next-day hours without wrapping them into the morning', () => {
    expect(screeningLanes([show('a','23:00','25:00'),show('b','24:30','26:00')]).get('b')).toEqual({lane:1,count:2});
  });
  it('restores the page time and venue after scaling, and fit only resets venues', () => {
    const old: VerticalGeometry = {start:480,end:1500,ppm:2,columnWidth:260,railWidth:72,topPad:18,headerHeight:64,width:2000,height:2060};
    const anchor = captureVerticalAnchor(old,{scrollLeft:600,clientWidth:800,top:-400},{scrollY:900,height:1000});
    const next = {...old,ppm:1.8,columnWidth:234};
    const position = restoreVerticalAnchor(anchor,next,500);
    const restored = captureVerticalAnchor(next,{scrollLeft:position.left,clientWidth:800,top:500-position.pageY},{scrollY:position.pageY,height:1000});
    expect(restored.minute).toBeCloseTo(anchor.minute!);
    expect(restored.venue).toBeCloseTo(anchor.venue);
    expect(restoreVerticalAnchor(anchor,next,500,true)).toEqual({...position,left:0});
    const above = captureVerticalAnchor(old,{scrollLeft:0,clientWidth:800,top:500},{scrollY:0,height:1000});
    expect(restoreVerticalAnchor(above,next,500).pageY).toBe(0);
  });
});
