import {flushSync} from 'react-dom';
import {useLayoutEffect, useRef, useSyncExternalStore} from 'react';
import {DialogContainer, Dialog, Heading, Content, ButtonGroup, Button, ToastQueue} from './spectrum';
import './account-ui.css';

type Panel = {title: string; body: HTMLElement};
let panel: Panel | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {listeners.add(listener);return () => {listeners.delete(listener);};};
const emit = () => listeners.forEach(listener => listener());
export function el(tag: string, cls = '', text?: string): HTMLElement {
  const node = document.createElement(tag);node.className = cls;if(text !== undefined) node.textContent = text;return node;
}
export function openModal(title: string, body: HTMLElement, _size?: string) {flushSync(() => {panel = {title,body};emit();});}
export function closeModal() {panel = null;emit();}
export function toast(message: string) {ToastQueue.neutral(message,{timeout:5000});}
function Body({body}: {body: HTMLElement}) {
  const ref=useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {ref.current?.replaceChildren(body);return () => {body.remove();};},[body]);
  return <div id="modal-root" className="account-content" ref={ref} />;
}
export function AccountHost() {
  const current = useSyncExternalStore(subscribe, () => panel);
  return <DialogContainer onDismiss={closeModal}>{current && <Dialog size="L"><Heading slot="title">{current.title}</Heading><Content><Body body={current.body} /></Content><ButtonGroup><Button variant="secondary" onPress={closeModal}>关闭</Button></ButtonGroup></Dialog>}</DialogContainer>;
}
