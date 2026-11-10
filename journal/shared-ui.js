import {DeviceStore,SharedJournal} from './shared-store.js';
import {newRecovery} from './shared-crypto.js';
import {canonical} from './shared-model.js';

const $=selector=>document.querySelector(selector);
function download(value,name) {
  const url=URL.createObjectURL(new Blob([typeof value==='string'?value:JSON.stringify(value)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function readBackup(file) {
  if(!file || file.size>10*1024*1024) throw new Error('请选择小于 10 MB 的加密备份。');
  return JSON.parse(await file.text());
}
export async function initializeShared(onUpdate) {
  const store=await new DeviceStore().open(),journal=new SharedJournal(store);
  let current=await journal.snapshot(),timer,busy=false;
  $('.app-shell').hidden=true;
  $('.demo-notice').textContent='rakkat · 正在打开你的空间';
  const welcome=document.createElement('section');welcome.className='welcome settings-card';
  welcome.innerHTML=`<p class="eyebrow">A PLACE FOR TWO</p><h1>从今天起，<br>把小事写给彼此。</h1><p>在这台手机上连接一次，以后直接打开就能记录。</p>
    <form id="join-space"><label>开始方式<select id="join-mode"><option value="create">建立我们的空间</option><option value="join">加入 / 恢复已有空间</option></select></label>
    <label>选择身份<select id="join-person" required><option value="" disabled selected>请选择身份</option><option value="0">身份：小獭</option><option value="1">身份：猫猫</option></select></label>
    <label>空间恢复码<textarea id="join-recovery" rows="3" autocomplete="off" autocapitalize="none" spellcheck="false" required></textarea></label>
    <p class="small" id="recovery-help">请另行保存恢复码，另一台手机加入和换机时会用到。丢失后无法代找。</p>
    <label class="checkbox-label" id="recovery-confirm"><input id="recovery-saved" type="checkbox">我已在此网页之外保存恢复码</label>
    <label>访问令牌<input id="join-token" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="粘贴已准备好的令牌" required></label>
    <label id="restore-file-label" hidden>云端文件丢失时，从加密备份恢复（可选）<input id="restore-file" type="file" accept=".json,application/json"></label>
    <p class="small">这台手机会记住连接，请在自己的设备上使用。</p>
    <button class="primary" id="join-submit" type="submit">连接并记住此设备</button><p class="form-message" id="join-message" role="status"></p></form>`;
  document.body.prepend(welcome);
  let generated=newRecovery();$('#join-recovery').value=generated;$('#join-recovery').readOnly=true;
  $('#join-mode').addEventListener('change',()=>{
    const create=$('#join-mode').value==='create';$('#join-recovery').readOnly=create;$('#join-recovery').value=create?generated:'';
    $('#recovery-confirm').hidden=!create;$('#restore-file-label').hidden=create;
  });
  if(!current) await new Promise(resolve=>{
    $('#join-space').addEventListener('submit',async event=>{
      event.preventDefault();$('#join-message').textContent='正在连接…';$('#join-submit').disabled=true;
      try {
        const create=$('#join-mode').value==='create';
        if(!['0','1'].includes($('#join-person').value)) throw new Error('请选择小獭或猫猫。');
        if(create && !$('#recovery-saved').checked) throw new Error('请先保存恢复码，并勾选确认。');
        const file=$('#restore-file').files[0];
        current=await journal.setup({token:$('#join-token').value.trim(),recovery:$('#join-recovery').value,active:Number($('#join-person').value),create,backup:file?await readBackup(file):null});
        $('#join-token').value='';$('#join-recovery').value='';generated='';resolve();
      } catch(error) {$('#join-message').textContent=error.message;}
      finally {$('#join-submit').disabled=false;}
    });
  });
  welcome.remove();$('.app-shell').hidden=false;
  $('.demo-notice').innerHTML='<span id="sync-status" role="status">已在本机打开</span> <button id="sync-now" class="text-button">同步</button>';
  const card=document.createElement('div');card.className='settings-card full-width';
  card.innerHTML=`<h3>这台手机与我们的空间</h3><p>日记先保存在这台手机，联网后自动同步。</p>
    <label>这台手机的身份<select id="device-person"></select></label><div class="device-actions"><button type="button" class="secondary" id="show-recovery">查看恢复码</button><button type="button" class="text-button" id="refresh-access">更新访问授权</button><button type="button" class="text-button danger" id="leave-device">退出此设备</button></div>
    <p class="small">退出会清除这台浏览器里的记录、草稿和连接信息，已同步的内容保留。</p><div id="sync-conflicts"></div>`;
  $('.settings-grid').prepend(card);
  const dialog=document.createElement('dialog');dialog.id='device-dialog';
  dialog.innerHTML='<div class="dialog-head"><h2 id="device-heading"></h2><button class="icon-button" id="device-close" aria-label="关闭">×</button></div><div id="device-content"></div>';
  document.body.append(dialog);$('#device-close').onclick=()=>{dialog.close();$('#device-content').replaceChildren();};
  dialog.addEventListener('close',()=>$('#device-content').replaceChildren());
  const emit=snapshot=>{current=snapshot;onUpdate(snapshot);renderStatus();};
  function renderStatus(message) {
    $('#sync-status').textContent=message || (current.pending?'已保存在本机 · 等待同步':`已同步${current.lastSync?' · '+new Date(current.lastSync).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):''}`);
    $('#sync-now').disabled=busy;
    $('#device-person').replaceChildren(...current.state.people.map((name,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=`身份：${name}`;return option;}));$('#device-person').value=String(current.active);
    const container=$('#sync-conflicts');container.replaceChildren();
    if(current.conflicts.length) {
      const heading=document.createElement('h3');heading.textContent=`有 ${current.conflicts.length} 处并行修改待确认`;container.append(heading);
      const hint=document.createElement('p');hint.textContent='两个版本都已保留。请先阅读，再选择要继续使用的版本；选择前可导出加密备份。';container.append(hint);
      for(const conflict of current.conflicts) {
        const group=document.createElement('details'),summary=document.createElement('summary');
        const kind=conflict.key.split('/')[0];summary.textContent=({entry:'一篇日记',event:'一条日期记录',setting:'空间设置',comment:'一条留言',like:'喜欢标记'})[kind] || '一条记录';group.append(summary);
        conflict.versions.forEach((version,index)=>{
          const pre=document.createElement('pre');pre.textContent=version.value===null?'已移除':typeof version.value==='object'?Object.entries(version.value).filter(([key])=>['title','body','note','date','start','end','deleted'].includes(key)).map(([key,value])=>`${({title:'标题',body:'内容',note:'备注',date:'日期',start:'开始',end:'结束',deleted:'已删除'})[key]}：${value}`).join('\n'):String(version.value);
          const button=document.createElement('button');button.className='secondary';button.textContent=`保留版本 ${index+1}`;
          button.onclick=async()=>{if(!confirm('确定采用这个版本？其他并行版本会从当前记录中移除。'))return;try {emit(await journal.resolve(conflict.key,canonical(conflict.versions),index));schedule();}catch(error){renderStatus(error.message);}};
          group.append(pre,button);
        });container.append(group);
      }
    }
    const periods=current.state.events.filter(event=>!event.deleted && event.kind==='period');
    if(periods.some((a,index)=>periods.slice(index+1).some(b=>a.subject===b.subject && a.start<=(b.end || '9999-12-31') && b.start<=(a.end || '9999-12-31')))) {
      const note=document.createElement('p');note.textContent='同步后发现重叠的经期日期，两条都已保留。请在纪念日页核对并调整。';container.append(note);
    }
  }
  async function sync() {
    if(busy)return;busy=true;renderStatus('正在同步…');
    try {emit(await journal.sync());if(current.pending)schedule();}
    catch(error){renderStatus(error.message);}
    finally {busy=false;$('#sync-now').disabled=false;}
  }
  function schedule() {clearTimeout(timer);timer=setTimeout(()=>{if(document.visibilityState!=='hidden')void sync();},10000);}
  $('#sync-now').onclick=()=>void sync();
  $('#device-person').onchange=async event=>{await journal.setActive(Number(event.target.value));emit(await journal.snapshot());};
  $('#show-recovery').onclick=async()=>{
    $('#device-heading').textContent='保存好我们的恢复码';
    const help=document.createElement('p');help.textContent='另一台手机加入或换机恢复时使用。请存进密码管理器；不要发到公开页面或聊天中。';
    const code=document.createElement('textarea');code.readOnly=true;code.rows=4;code.value=await journal.recovery();code.setAttribute('aria-label','空间恢复码');
    const copy=document.createElement('button');copy.className='primary';copy.textContent='复制恢复码';copy.onclick=async()=>{try{await navigator.clipboard.writeText(code.value);copy.textContent='已复制';}catch{code.focus();code.select();copy.textContent='请长按选中文字复制';}};
    $('#device-content').replaceChildren(help,code,copy);dialog.showModal();
  };
  $('#refresh-access').onclick=()=>{
    $('#device-heading').textContent='更新访问授权';
    const form=document.createElement('form');form.innerHTML='<p>填入新的访问令牌，已有日记和恢复码继续保留。</p><label>新的访问令牌<input type="password" name="token" autocomplete="off" autocapitalize="none" spellcheck="false" required></label><button class="primary" type="submit">验证并保存</button><p class="form-message" role="status"></p>';
    form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{await journal.replaceToken(form.elements.token.value.trim());form.elements.token.value='';dialog.close();void sync();}catch(error){form.querySelector('[role=status]').textContent=error.message;}finally{button.disabled=false;}};
    $('#device-content').replaceChildren(form);dialog.showModal();
  };
  $('#leave-device').onclick=async()=>{
    const latest=await journal.snapshot();
    if(!confirm(`${latest.pending?'还有尚未同步的记录。请先同步或导出加密备份，否则退出会丢失这些内容。\n\n':''}确认已保存恢复码，并清除这台浏览器的所有记录、草稿和授权？`))return;
    await store.clear();location.reload();
  };
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void sync();});
  window.addEventListener('online',()=>void sync());
  setInterval(()=>{if(document.visibilityState==='visible' && !document.querySelector('dialog[open]'))void sync();},60000);
  renderStatus();setTimeout(()=>void sync(),0);
  return {journal,current,changed:async()=>{emit(await journal.snapshot());schedule();},export:async()=>download(await journal.exportBackup(),`rakkat加密备份-${new Date().toISOString().slice(0,10)}.json`),import:async file=>{emit(await journal.importBackup(await readBackup(file)));schedule();}};
}
