import {privateCheck} from './private-core.js';
const $=selector=>document.querySelector(selector);
const steps=['privacy','write','read','cleanup'];
let report='';
$('#run').addEventListener('click',async()=>{
  if(!$('#vpn-off').checked) {$('#hint').textContent='请先关闭代理 / VPN，并确认令牌只授权了指定私有仓库。';return;}
  if(!globalThis.crypto?.subtle || !window.isSecureContext) {$('#hint').textContent='当前页面无法使用安全加密，请通过 HTTPS 在 Safari 中打开。';return;}
  const network=$('#network').value;
  let token=$('#token').value.trim();$('#token').value='';
  $('#run').disabled=true;$('#network').disabled=true;$('#token').disabled=true;$('#vpn-off').disabled=true;$('#copy').hidden=true;$('#report').hidden=true;
  for(const step of steps){$(`#${step}-result`).textContent='等待检查';delete $(`#${step}-result`).dataset.state;}
  $('#hint').textContent='正在检查，通常需要几秒到一分钟…';
  try {
    const result=await privateCheck(token,{onProgress:(step,message)=>{const node=$(`#${step}-result`);node.textContent=message;node.dataset.state=message.startsWith('通过')?'ok':'';}});
    $('#summary').textContent=result.message;
    report=['rakkat私有读写检查',new Date().toLocaleString(),`网络：${network}；代理 / VPN：已关闭（手动确认）`,...steps.map(step=>$(`#${step}-result`).parentNode.textContent),result.message,`测试文件：${result.cleanup}`].join('\n');
    $('#report').value=report;$('#copy').hidden=false;$('#hint').textContent='检查结束，输入框已清空。可复制结果，报告中不包含令牌。';
  } catch {$('#summary').textContent='本次测试未完成，没有确认读写成功。';}
  finally {token='';$('#token').value='';$('#run').disabled=false;$('#network').disabled=false;$('#token').disabled=false;$('#vpn-off').disabled=false;}
});
$('#copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(report);$('#hint').textContent='结果已复制。';}catch{$('#report').hidden=false;$('#report').focus();$('#report').select();$('#hint').textContent='请长按下方文字复制结果。';}});
window.addEventListener('pagehide',()=>{$('#token').value='';});
