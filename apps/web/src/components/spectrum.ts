export { ActionButton } from "@react-spectrum/s2/ActionButton";
// 顶部辅助区的「更多」是「一个按钮 + 一个菜单」的标准形态(`ActionMenu` 就是为此存在的):
// 2026-09-22 把「设置 / 说明 / 导出与分享」三项收进去(`PLAN-20260922105228`)。
export { ActionMenu, MenuItem } from "@react-spectrum/s2/ActionMenu";
export { Button } from "@react-spectrum/s2/Button";
export { ButtonGroup } from "@react-spectrum/s2/ButtonGroup";
export { Checkbox } from "@react-spectrum/s2/Checkbox";
export { CheckboxGroup } from "@react-spectrum/s2/CheckboxGroup";
export {
  Dialog,
  DialogTrigger,
  DialogContainer,
  Heading,
  Content,
  Footer,
} from "@react-spectrum/s2/Dialog";
export {
  Disclosure,
  DisclosureTitle,
  DisclosurePanel,
} from "@react-spectrum/s2/Disclosure";
export { Link } from "@react-spectrum/s2/Link";
export { NumberField } from "@react-spectrum/s2/NumberField";
export { Picker, PickerItem } from "@react-spectrum/s2/Picker";
export { SearchField } from "@react-spectrum/s2/SearchField";
export { TextField } from "@react-spectrum/s2/TextField";
// ref 类型:搜索框要拿原生 input 挂组合态监听(`QuerySearchField`),而 S2 的 props 把
// `GlobalDOMAttributes` 整个 Omit 掉了 —— 事件处理器传不进去,只能走 ref。
export type { TextFieldRef } from "@react-spectrum/s2/TextField";
export { TextArea } from "@react-spectrum/s2/TextArea";
export { ToggleButton } from "@react-spectrum/s2/ToggleButton";
export { ToastContainer } from "@react-spectrum/s2/Toast";
// ToastQueue 走本地包装,不直接 re-export S2 的那只 —— S2 不传 `timeout` 就永不自动关闭,
// 提示会常驻屏幕底部(见 `components/toast.ts` 的说明与 `tests/toast-timeout.test.ts`)。
export { ToastQueue } from "./toast";
export { Tooltip, TooltipTrigger } from "@react-spectrum/s2/Tooltip";
