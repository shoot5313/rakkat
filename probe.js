import {probes,check,conclusion} from './probe-core.js';
const $=selector=>document.querySelector(selector);
let report='';
$('#run').addEventListener('click',async()=>{
  if(!$('#vpn-off').checked) { $('#hint').textContent='请先关闭代理 / VPN，再勾选上面的确认项。'; return; }
  const mode=$('#network').value;
  $('#run').disabled=true; $('#network').disabled=true; $('#vpn-off').disabled=true;
  $('#copy').hidden=true; $('#report').hidden=true;
  $('#hint').textContent='正在逐项检查，最长约 30 秒…';
  $('#summary').textContent='检查过程中请保持当前网络。';
  const items=probes(location.href);
  for(const item of items) { const element=$(`#${item.id}-result`);element.textContent='等待检查';delete element.dataset.state; }
  const results=[];
  for(const item of items) {
    const element=$(`#${item.id}-result`); element.textContent='检查中…';
    const result=await check(item); results.push(result);
    element.textContent=result.detail;element.dataset.state=result.ok?'ok':'failed';
  }
  const summary=conclusion(results);
  $('#summary').textContent=summary;
  report=[`rakkat GitHub 连接检查`,new Date().toLocaleString(),`网络：${mode}；代理 / VPN：已关闭（手动确认）`,...items.map((item,i)=>`${item.label}：${results[i].detail}`),summary].join('\n');
  $('#report').value=report; $('#copy').hidden=false;
  $('#hint').textContent='检查完成，可以复制结果发给协助部署的人。';
  $('#run').disabled=false;$('#network').disabled=false;$('#vpn-off').disabled=false;
});
$('#copy').addEventListener('click',async()=>{
  try { await navigator.clipboard.writeText(report);$('#hint').textContent='结果已复制。'; }
  catch { $('#report').hidden=false;$('#report').focus();$('#report').select();$('#hint').textContent='请长按下方文字复制结果。'; }
});
