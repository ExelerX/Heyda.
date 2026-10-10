// The pure encoder inside the qrcode package; the package entry pulls in Node/canvas code.
declare module 'qrcode/lib/core/qrcode' {
  export { create } from 'qrcode';
}
