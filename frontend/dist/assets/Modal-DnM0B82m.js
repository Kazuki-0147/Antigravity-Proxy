import{c as m,_ as f,p as h,B as k,h as p,o as a,e as r,g as v,b as o,k as s,w as b,d,A as w,t as M,f as V,X as x,Y as u,Z as B,$ as E}from"./index-pVp0Zfh9.js";/**
 * @license lucide-vue-next v0.344.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const L=m("PowerIcon",[["path",{d:"M12 2v10",key:"mnfbl"}],["path",{d:"M18.4 6.6a9 9 0 1 1-12.77.04",key:"obofu9"}]]);/**
 * @license lucide-vue-next v0.344.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const N=m("Trash2Icon",[["path",{d:"M3 6h18",key:"d0wm0j"}],["path",{d:"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6",key:"4alrt4"}],["path",{d:"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2",key:"v07s0e"}],["line",{x1:"10",x2:"10",y1:"11",y2:"17",key:"1uufr5"}],["line",{x1:"14",x2:"14",y1:"11",y2:"17",key:"xtxkd"}]]),S={key:0,class:"modal-header"},T={class:"modal-title"},_={class:"modal-body"},g={key:1,class:"modal-footer"},C={__name:"Modal",props:{modelValue:{type:Boolean,default:!1},title:{type:String,default:""},width:{type:String,default:"480px"},closable:{type:Boolean,default:!0}},emits:["update:modelValue","close"],setup(e,{emit:y}){const n=e,c=y,l=()=>{n.closable&&(c("update:modelValue",!1),c("close"))},i=t=>{t.key==="Escape"&&n.modelValue&&l()};return h(()=>{document.addEventListener("keydown",i)}),k(()=>{document.removeEventListener("keydown",i)}),(t,I)=>(a(),p(E,{to:"body"},[r(B,{name:"modal"},{default:v(()=>[e.modelValue?(a(),o("div",{key:0,class:"modal-overlay",onClick:b(l,["self"])},[d("div",{class:"modal",style:w({maxWidth:e.width})},[e.title||e.closable?(a(),o("div",S,[d("h3",T,M(e.title),1),e.closable?(a(),o("button",{key:0,class:"modal-close",onClick:l},[r(V(x),{size:20})])):s("",!0)])):s("",!0),d("div",_,[u(t.$slots,"default",{},void 0,!0)]),t.$slots.footer?(a(),o("div",g,[u(t.$slots,"footer",{},void 0,!0)])):s("",!0)],4)])):s("",!0)]),_:3})]))}},P=f(C,[["__scopeId","data-v-2a9ad40e"]]);export{P as M,L as P,N as T};
