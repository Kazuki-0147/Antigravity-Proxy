import{c}from"./index-pVp0Zfh9.js";/**
 * @license lucide-vue-next v0.344.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const a=c("CopyIcon",[["rect",{width:"14",height:"14",x:"8",y:"8",rx:"2",ry:"2",key:"17jyea"}],["path",{d:"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",key:"zix9uf"}]]);async function n(t){if(navigator.clipboard&&window.isSecureContext)try{return await navigator.clipboard.writeText(t),!0}catch(e){console.warn("Clipboard API failed:",e)}try{const e=document.createElement("textarea");e.value=t,e.style.position="fixed",e.style.left="-9999px",e.style.top="-9999px",document.body.appendChild(e),e.focus(),e.select();const o=document.execCommand("copy");if(document.body.removeChild(e),o)return!0}catch(e){console.error("execCommand copy failed:",e)}return!1}export{a as C,n as c};
