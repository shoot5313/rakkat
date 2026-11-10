import { validateBackup } from './backup.js';
import { eventKinds, validDate, daysBetween, nextOccurrence, occursOn, calendarDays, eventInputError, mergeEvents } from './dates.js';
import { initializeShared } from './shared-ui.js';
import { canonical, DEFAULT_PEOPLE, displayPeople } from './shared-model.js';
const isShared = document.body.dataset.shared === 'true';
let shared, editingBase = null, eventEditingBase = null, detailBase = null, settingsBase;
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const uid = () => crypto.randomUUID();
const today = () => localDate(new Date());
function localDate(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
const dayBefore = days => { const date = new Date(); date.setDate(date.getDate()-days); return localDate(date); };
const prettyDate = value => { const [year,month,day] = value.split('-'); return `${year}.${month}.${day}`; };
let db, state, tab = 'diary', filter = 'all', active = 0, editingId = null, openId = null, attachments = [], draftTimer, toastTimer;
let mutationQueue = Promise.resolve();
let eventFilter = 'all', selectedDay = today(), calendarMonth = today().slice(0,7), editingEventId = null;
const channel = 'BroadcastChannel' in window ? new BroadcastChannel(isShared ? 'little-days-shared' : 'little-days') : null;

function toast(message) {
  clearTimeout(toastTimer);
  const element = $('#toast');
  const dialogs = [...document.querySelectorAll('dialog[open]')];
  (dialogs.at(-1) || document.body).append(element);
  element.textContent = message; element.classList.add('visible');
  toastTimer = setTimeout(() => element.classList.remove('visible'),3800);
}
function requestValue(request) { return new Promise((resolve,reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function read(key) { if(shared) return key === 'state' ? shared.journal.snapshot().then(value=>value.state) : shared.journal.draft(key); return requestValue(db.transaction('data').objectStore('data').get(key)); }
function write(key, value) { if(shared) return shared.journal.draft(key,value); return new Promise((resolve,reject) => { const transaction = db.transaction('data','readwrite'); transaction.objectStore('data').put(value,key); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error || new Error('Storage transaction aborted')); }); }
function mutate(update) {
  const task = mutationQueue.then(async () => {
    if(shared) {await shared.journal.mutate(update);await shared.changed();channel?.postMessage('updated');return;}
    // Read and write in one transaction, so another tab cannot overwrite a stale snapshot.
    const next = await new Promise((resolve,reject) => {
      const transaction = db.transaction('data','readwrite'); const store = transaction.objectStore('data'); let result;
      const request = store.get('state');
      request.onsuccess = () => {
        try { result = request.result; result.events ??= []; result.version = 2; update(result); store.put(result,'state'); }
        catch(error) { transaction.abort(); reject(error); }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('保存被中断'));
    });
    state = next; render(); channel?.postMessage('updated');
  });
  mutationQueue = task.catch(() => {});
  return task;
}
function sampleState() {
  const now = Date.now();
  return { version:2, title:'rakkat', people:[...DEFAULT_PEOPLE], anniversary:'', events:[], entries:[
    {id:uid(),author:0,date:dayBefore(0),title:'今天的晚风，适合一起走走',body:'下班的时候，发现天边是很淡的粉色。\n走到路口，忍不住想：要是你也在就好了。\n\n下次见面，我们绕一点远路回家吧。',mood:'想你',photos:[],comments:[{id:uid(),author:1,body:'好呀，顺便去买你喜欢的那家面包。',created:now}],likes:[1],created:now,updated:now,example:true},
    {id:uid(),author:1,date:dayBefore(1),title:'一起把普通日子过得亮一点',body:'想有一个地方，放那些不适合发朋友圈、但很想让你知道的小事。\n\n今天午饭很好吃，路边的猫很可爱，还有，我很想你。',mood:'晴朗',photos:[],comments:[],likes:[0],created:now-1000,updated:now-1000,example:true},
    {id:uid(),author:0,date:dayBefore(3),title:'记住一个小小的约定',body:'以后遇到开心的事，就在这里存一份。\n不开心的时候也可以来，慢慢说，我会听。',mood:'平静',photos:[],comments:[],likes:[],created:now-2000,updated:now-2000,example:true}
  ]};
}
function visibleEntries() { return state.entries.filter(entry => !entry.deleted).sort((a,b) => b.date.localeCompare(a.date) || b.created-a.created); }
function avatar(author) { return `<span class="avatar ${author ? 'partner' : ''}">${escape(Array.from(state.people[author])[0])}</span>`; }
function entryTop(entry) { return `<div class="card-top">${avatar(entry.author)}<span>${escape(state.people[entry.author])}</span>${entry.example ? '<span class="example">示例</span>' : ''}<span class="date">${prettyDate(entry.date)}</span></div>`; }
function empty(title,subtitle,symbol='♡') { return `<div class="empty"><span class="empty-symbol">${symbol}</span>${title}<p>${subtitle}</p></div>`; }
function render() {
  state.people = displayPeople(state.people);
  const title = ['两个人的小日子','小日子'].includes(state.title) ? 'rakkat' : state.title;
  document.title = title;
  $('#identity').innerHTML = `${avatar(active)}<span>身份：${escape(state.people[active])}</span><span class="switch-hint">切换体验身份 ⇄</span>`;
  $('#identity').title = isShared ? '在我们的空间中设置本机身份' : '切换演示身份';
  const heroTitle = $('.hero h1');
  if(title === 'rakkat') heroTitle.innerHTML = '<span>rakkat</span>'; else heroTitle.textContent = title;
  renderEntries(); renderDates();
  if(!$('#settings').contains(document.activeElement) && !$('#settings').dataset.dirty) {
    $('#settings').elements.title.value = title;
    $('#settings').elements.person0.value = state.people[0];
    $('#settings').elements.person1.value = state.people[1];
    $('#settings').elements.anniversary.value = state.anniversary;
    settingsBase={title:state.title,people:[...state.people],anniversary:state.anniversary};
  }
  const own = visibleEntries().filter(entry => !entry.example);
  let days = '';
  if(state.anniversary) { const elapsed = Math.floor((Date.parse(today())-Date.parse(state.anniversary))/86400000)+1; days = `<span>${elapsed > 0 ? `一起走过 ${elapsed} 天` : '等待我们的第一天'}</span>`; }
  $('#stats').innerHTML = `<span>${own.length} 篇日记</span><span>${(state.events || []).filter(event => !event.deleted).length} 条日期记录</span>${days}`;
  const legacyPhotos = state.entries.reduce((sum,entry) => sum+entry.photos.length,0);
  $('#legacy-photos').hidden = !legacyPhotos;
  $('#legacy-photos').textContent = `旧版记录的 ${legacyPhotos} 张照片仍保留在完整导出的备份里。`;
  $('#clear-examples').hidden = !state.entries.some(entry => entry.example && !entry.deleted);
}
function renderEntries() {
  const query = $('#search').value.trim().toLocaleLowerCase();
  const author = filter === 'all' ? null : filter === '0' ? active : 1-active;
  const entries = visibleEntries().filter(entry => (author === null || entry.author === author) && `${entry.title}\n${entry.body}\n${entry.date}\n${entry.mood}`.toLocaleLowerCase().includes(query));
  $('#entries').innerHTML = entries.length ? entries.map(entry => `<button class="entry-card" data-entry="${entry.id}" aria-label="阅读：${escape(entry.title || entry.date)}">${entryTop(entry)}<h3>${escape(entry.title || '今天的小记')}</h3><p class="entry-excerpt">${escape(entry.body)}</p><div class="card-bottom"><span class="mood">${entry.mood === '晴朗' ? '☀' : '◌'} ${escape(entry.mood)}</span><span>${entry.likes.length ? `♡ ${entry.likes.length} · ` : ''}${entry.comments.length ? `${entry.comments.length} 条悄悄话` : '留一句悄悄话 ↗'}</span></div></button>`).join('') : empty(query ? '还没找到这段回忆' : '这一页，等你来写',query ? '换个词试试，或者清空搜索。' : '点一下「记下今天」，留住第一件小事。');
}
function setTab(value) {
  tab = ['diary','dates','space'].includes(value) ? value : 'diary';
  document.querySelectorAll('[data-tab]').forEach(button => { if(button.dataset.tab === tab) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); });
  ['diary','dates','space'].forEach(value => $(`#${value}-panel`).hidden = value !== tab);
  if(tab === 'dates') renderDates();
}
function calendarEvents() {
  const events = (state.events || []).filter(event => !event.deleted);
  if(state.anniversary) events.push({id:'relationship-anniversary',kind:'anniversary',title:'在一起的纪念日',start:state.anniversary,end:'',yearly:true,note:'在「我们的空间」中修改这一天。',virtual:true});
  return events;
}
function eventName(event) { return event.title || (event.kind === 'period' ? `${state.people[event.subject]}的经期` : eventKinds[event.kind]); }
function eventDateLabel(event) {
  if(event.yearly) return `每年 ${event.start.slice(5,7)} 月 ${event.start.slice(8)} 日 · 始于 ${event.start.slice(0,4)} 年`;
  if(event.kind === 'period') return `${prettyDate(event.start)} — ${event.end ? prettyDate(event.end) : '进行中'} · ${daysBetween(event.start,event.end || today())+1} 天`;
  return `${prettyDate(event.start)}${event.end && event.end !== event.start ? ` — ${prettyDate(event.end)}` : ''}`;
}
function eventButton(event,compact = false) {
  const date = nextOccurrence(event,today());
  const days = date ? daysBetween(today(),date) : null;
  const badge = event.kind !== 'period' && days !== null ? (days === 0 ? '就是今天' : `还有 ${days} 天`) : '';
  return `<button class="event-record ${compact ? 'compact' : ''}" data-event-id="${event.id}"><span class="event-type ${event.kind}">${eventKinds[event.kind]}</span><span class="event-text"><strong>${escape(eventName(event))}</strong><small>${escape(eventDateLabel(event))}</small>${!compact && event.note ? `<span class="event-note">${escape(event.note)}</span>` : ''}</span>${badge ? `<span class="event-countdown">${badge}</span>` : '<span class="event-arrow" aria-hidden="true">↗</span>'}</button>`;
}
function renderDates() {
  const all = calendarEvents();
  const now = today();
  const highlights = ['meeting','anniversary'].map(kind => {
    const upcoming = all.filter(event => event.kind === kind).map(event => ({event,date:nextOccurrence(event,now)})).filter(item => item.date).sort((a,b) => a.date.localeCompare(b.date))[0];
    return `<div class="date-highlight ${kind}"><p>${kind === 'meeting' ? '下一次见面' : '下一个纪念日'}</p>${upcoming ? `<strong>${daysBetween(now,upcoming.date) === 0 ? '就是今天' : `${daysBetween(now,upcoming.date)}<small> 天后</small>`}</strong><span>${escape(eventName(upcoming.event))}</span>` : `<strong>等你记下</strong><span>${kind === 'meeting' ? '给下一次见面留一个期待。' : '让重要的日子有个位置。'}</span>`}</div>`;
  });
  const latest = all.filter(event => event.kind === 'period').sort((a,b) => b.start.localeCompare(a.start))[0];
  highlights.push(`<div class="date-highlight period"><p>最近的经期记录</p>${latest ? `<strong>${latest.end ? `共 ${daysBetween(latest.start,latest.end)+1} 天` : `第 ${daysBetween(latest.start,now)+1} 天`}</strong><span>${escape(state.people[latest.subject])} · ${prettyDate(latest.start)} 开始</span>` : '<strong>照顾每一天</strong><span>记录实际日期和身体感受。</span>'}</div>`);
  $('#date-highlights').innerHTML = highlights.join('');
  $('#calendar-month').textContent = `${calendarMonth.slice(0,4)} 年 ${Number(calendarMonth.slice(5))} 月`;
  const filtered = all.filter(event => eventFilter === 'all' || event.kind === eventFilter);
  $('#calendar-days').innerHTML = calendarDays(calendarMonth).map(day => {
    const onDay = filtered.filter(event => occursOn(event,day,now));
    const kinds = [...new Set(onDay.map(event => event.kind))];
    return `<button class="calendar-day ${day.slice(0,7) !== calendarMonth ? 'outside' : ''} ${day === now ? 'today' : ''} ${day === selectedDay ? 'selected' : ''}" data-calendar-day="${day}" aria-pressed="${day === selectedDay}" ${day === now ? 'aria-current="date"' : ''} aria-label="${day}${onDay.length ? `，${onDay.length} 条记录：${escape(kinds.map(kind => eventKinds[kind]).join('、'))}` : ''}"><span>${Number(day.slice(8))}</span><span class="calendar-dots" aria-hidden="true">${kinds.map(kind => `<i class="event-dot ${kind}"></i>`).join('')}</span></button>`;
  }).join('');
  $('#selected-day').textContent = `${Number(selectedDay.slice(5,7))} 月 ${Number(selectedDay.slice(8))} 日${selectedDay === now ? ' · 今天' : ''}`;
  const selected = filtered.filter(event => occursOn(event,selectedDay,now));
  $('#day-events').innerHTML = selected.length ? selected.map(event => eventButton(event,true)).join('') : '<p class="day-empty">这一天还没有符合筛选的记录。<br>想记下什么，都可以。</p>';
  const sorted = filtered.slice().sort((a,b) => {
    const nextA = nextOccurrence(a,now), nextB = nextOccurrence(b,now);
    if(nextA && nextB) return nextA.localeCompare(nextB);
    if(nextA || nextB) return nextA ? -1 : 1;
    return b.start.localeCompare(a.start);
  });
  $('#event-list').innerHTML = sorted.length ? sorted.map(event => eventButton(event)).join('') : empty('把重要的日子留在这里','见面、经期、纪念日，或者只属于你们的小约定。','◷');
}
function updateEventFields() {
  const kind = $('#event-kind').value, period = kind === 'period', anniversary = kind === 'anniversary';
  if(!anniversary) $('#event-yearly').checked = false;
  $('#event-subject-label').hidden = !period;
  $('#event-yearly-label').hidden = !anniversary;
  $('#event-end-label').hidden = anniversary && $('#event-yearly').checked;
  $('#event-end').disabled = $('#event-end-label').hidden;
  $('#event-start-label').textContent = period ? '开始日期' : '日期';
  $('#event-start').max = $('#event-end').max = period ? today() : '9999-12-31';
  $('#event-end').min = $('#event-start').value || '1900-01-01';
  $('#event-title').placeholder = period ? '比如：这一次的身体小记' : '比如：周末见面、第一次旅行';
  $('#event-hint').textContent = period ? '结束日期留空表示仍在进行。这里记录实际发生的日期，不预测下一次经期。' : anniversary ? '可每年重复显示。2 月 29 日的纪念日在非闰年按 2 月 28 日显示。' : '可以记下过去的一天，也可以约定下一次见面。';
  const event = (state.events || []).find(item => item.id === editingEventId);
  $('#end-period').hidden = !(event && period && !event.end && !$('#event-end').value);
}
function openEventEditor(id = null,date = today()) {
  if(id === 'relationship-anniversary') { setTab('space'); $('#settings').elements.anniversary.focus(); return; }
  const event = id ? (state.events || []).find(item => item.id === id && !item.deleted) : null;
  if(id && !event) return;
  editingEventId = id;
  eventEditingBase = event ? canonical(event) : null;
  $('#event-editor-heading').textContent = event ? '再添一点细节' : '记住一个日子';
  $('#event-kind').value = event?.kind || 'meeting';
  $('#event-subject').innerHTML = state.people.map((name,index) => `<option value="${index}">${escape(name)}</option>`).join('');
  $('#event-subject').value = String(event?.subject ?? active);
  $('#event-title').value = event?.title || ''; $('#event-note').value = event?.note || '';
  $('#event-start').value = event?.start || date; $('#event-end').value = event?.end || '';
  $('#event-yearly').checked = event?.yearly || false;
  $('#delete-event').hidden = !event; updateEventFields(); $('#event-editor').showModal();
}
function eventFormValue() {
  const kind = $('#event-kind').value;
  const yearly = kind === 'anniversary' && $('#event-yearly').checked;
  return {kind,subject:kind === 'period' ? Number($('#event-subject').value) : null,title:$('#event-title').value.trim(),note:$('#event-note').value.trim(),start:$('#event-start').value,end:yearly ? '' : $('#event-end').value,yearly};
}
function moveMonth(offset) {
  const date = new Date(`${calendarMonth}-01`); date.setUTCMonth(date.getUTCMonth()+offset);
  const month = date.toISOString().slice(0,7); if(month < '1900-01' || month > '9999-12') return;
  calendarMonth = month; selectedDay = `${month}-01`; renderDates();
}
async function openEditor(id = null) {
  const entry = id ? state.entries.find(item => item.id === id && !item.deleted) : await read(`draft-${active}`);
  if(id && (!entry || entry.author !== active)) return;
  editingId = id; attachments = [...(entry?.photos || [])];
  editingBase = id ? entryContent(entry) : null;
  $('#editor-heading').textContent = id ? '再添一点回忆' : '今天想告诉你…';
  $('#entry-title').value = entry?.title || ''; $('#entry-body').value = entry?.body || '';
  $('#entry-date').value = entry?.date || today(); $('#entry-mood').value = entry?.mood || '晴朗';
  $('#draft-status').textContent = id ? '保存后，对方也会看到这次修改。' : entry ? '已接着上次的草稿。' : '写给对方，也留给未来的我们。';
  $('#editor').showModal();
}
function entryContent(entry) {if(!entry)return '';const {comments,likes,updated,...content}=entry;return canonical(content);}
function draftValue() { return {title:$('#entry-title').value,body:$('#entry-body').value,date:$('#entry-date').value,mood:$('#entry-mood').value,photos:[...attachments]}; }
async function saveDraft() {
  clearTimeout(draftTimer);
  if(editingId) return;
  try { await write(`draft-${active}`,draftValue()); $('#draft-status').textContent = '草稿已保存在这个浏览器。'; }
  catch { toast('草稿保存失败，请复制文字或释放设备空间。'); }
}
function closeDialog(id) {
  if(id === 'event-editor' && !confirm('关闭后不会保存这次填写的内容，确定关闭吗？')) return;
  if(id === 'editor') {
    if(editingId && !confirm('关闭后不会保存这次修改，确定关闭吗？')) return;
    if(!editingId) void saveDraft();
  }
  $(`#${id}`).close();
}
function showDetail(id) {
  const entry = state.entries.find(item => item.id === id && !item.deleted); if(!entry) return;
  openId = id;
  detailBase=entryContent(entry);
  $('#detail-content').innerHTML = `${entryTop(entry)}<h2 class="detail-title">${escape(entry.title || '今天的小记')}</h2><p class="detail-body">${escape(entry.body)}</p><div class="detail-controls"><button class="secondary detail-like ${entry.likes.includes(active) ? 'liked' : ''}" id="like-entry">${entry.likes.includes(active) ? '♥ 已收藏这份心情' : '♡ 喜欢这篇'}${entry.likes.length ? ` · ${entry.likes.length}` : ''}</button>${entry.author === active ? '<button class="text-button" id="edit-entry">编辑</button><button class="text-button danger" id="delete-entry">删除</button>' : ''}</div><h3 class="comments-heading">留给你的悄悄话</h3><div class="comments">${entry.comments.length ? entry.comments.map(comment => `<div class="comment">${avatar(comment.author)}<div class="comment-content"><strong>${escape(state.people[comment.author])}</strong><p>${escape(comment.body)}</p><small>${new Date(comment.created).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</small></div></div>`).join('') : '<p class="no-comments">看完了，就给对方留一句话吧。</p>'}</div><form class="comment-form" id="comment-form"><input name="comment" placeholder="想对你说…" maxlength="2000" required aria-label="留言内容"><button class="primary" type="submit">留下</button></form>`;
  if(!$('#detail').open) $('#detail').showModal();
}
function bindEvents() {
  document.addEventListener('click', async event => {
    const target = event.target.closest('button,a'); if(!target) return;
    try {
      if(target.dataset.tab) setTab(target.dataset.tab);
      if(target.dataset.eventFilter) { eventFilter = target.dataset.eventFilter; document.querySelectorAll('[data-event-filter]').forEach(button => button.classList.toggle('selected',button === target)); renderDates(); }
      if(target.dataset.calendarDay) { selectedDay = target.dataset.calendarDay; calendarMonth = selectedDay.slice(0,7); renderDates(); }
      if(target.dataset.eventId) openEventEditor(target.dataset.eventId);
      if(target.id === 'new-event') openEventEditor();
      if(target.id === 'add-on-day') openEventEditor(null,selectedDay);
      if(target.id === 'month-prev') moveMonth(-1);
      if(target.id === 'month-next') moveMonth(1);
      if(target.id === 'month-today') { selectedDay = today(); calendarMonth = selectedDay.slice(0,7); renderDates(); }
      if(target.id === 'end-period') { $('#event-end').value = today(); updateEventFields(); $('#event-form').requestSubmit(); }
      if(target.id === 'delete-event' && confirm('删除这条日期记录和备注？')) {
        await mutate(data => { const event = data.events.find(item => item.id === editingEventId); if(!event) throw new Error('记录已不存在'); if(isShared && canonical(event)!==eventEditingBase) throw new Error('记录已在另一处修改，请重新打开后再删除。'); Object.assign(event,{deleted:true,title:'',note:'',updated:Date.now()}); });
        $('#event-editor').close(); toast('这条日期记录已删除。');
      }
      if(target.dataset.close) closeDialog(target.dataset.close);
      if(target.dataset.entry) showDetail(target.dataset.entry);
      if(target.dataset.filter) { filter = target.dataset.filter; document.querySelectorAll('[data-filter]').forEach(button => button.classList.toggle('selected',button === target)); renderEntries(); }
      if(target.id === 'identity') { if(shared) {setTab('space');$('#device-person').focus();} else {active = 1-active; render(); toast(`正在体验「${state.people[active]}」的视角`);} }
      if(target.id === 'new-entry') await openEditor();
      if(target.id === 'like-entry') { await mutate(data => { const entry = data.entries.find(item => item.id === openId && !item.deleted); if(!entry) throw new Error('日记已删除'); entry.likes = entry.likes.includes(active) ? entry.likes.filter(person => person !== active) : [...entry.likes,active]; entry.updated = Date.now(); }); showDetail(openId); }
      if(target.id === 'edit-entry') { $('#detail').close(); await openEditor(openId); }
      if(target.id === 'delete-entry' && confirm('删除这篇日记和它的留言？如需保留，请先导出备份。')) { await mutate(data => { const entry = data.entries.find(item => item.id === openId); if(!entry || entry.author !== active) throw new Error('无法删除'); if(isShared && entryContent(entry)!==detailBase) throw new Error('日记已在另一处修改，请重新打开后再删除。'); Object.assign(entry,{deleted:true,title:'',body:'',photos:[],comments:[],likes:[],updated:Date.now()}); }); $('#detail').close(); toast('这篇日记已移除。'); }
      if(target.id === 'export') {
        if(shared) {await mutationQueue;await shared.export();toast('加密备份已生成，请另外保存恢复码。');return;}
        await mutationQueue; const latest = await read('state');
        const blob = new Blob([JSON.stringify({...latest,format:'little-days-backup',exportedAt:new Date().toISOString()},null,2)],{type:'application/json'});
        const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `rakkat备份-${today()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url),60000); toast('已生成备份文件，请妥善保存。');
      }
      if(target.id === 'import') $('#import-file').click();
      if(target.id === 'clear-examples' && confirm('移除所有示例日记？你自己新写的日记会保留。')) { await mutate(data => data.entries.forEach(entry => { if(entry.example) { entry.deleted = true; entry.updated = Date.now(); } })); toast('示例已移除，现在从你们的第一天开始。'); }
    } catch(error) { toast(`操作未完成：${error.message || '请检查浏览器存储空间。'}`); }
  });
  $('#search').addEventListener('input',renderEntries);
  ['#event-kind','#event-yearly','#event-start','#event-end'].forEach(selector => $(selector).addEventListener('change',updateEventFields));
  $('#event-editor').addEventListener('cancel',event => { event.preventDefault(); closeDialog('event-editor'); });
  $('#event-form').addEventListener('submit',async event => {
    event.preventDefault(); const value = eventFormValue();
    const error = eventInputError(value,state.events || [],today(),editingEventId); if(error) return toast(error);
    $('#save-event').disabled = true; $('#end-period').disabled = true;
    try {
      await mutate(data => {
        const error = eventInputError(value,data.events,today(),editingEventId); if(error) throw new Error(error);
        const now = Date.now();
        if(editingEventId) { const existing = data.events.find(item => item.id === editingEventId && !item.deleted); if(!existing) throw new Error('记录已被删除'); if(isShared && canonical(existing)!==eventEditingBase) throw new Error('这条日期记录已在另一处修改，请复制本次填写后重新打开核对。'); Object.assign(existing,value,{updated:now}); }
        else data.events.push({...value,id:uid(),author:active,created:now,updated:now});
      });
      selectedDay = value.start; calendarMonth = value.start.slice(0,7); eventFilter = 'all';
      document.querySelectorAll('[data-event-filter]').forEach(button => button.classList.toggle('selected',button.dataset.eventFilter === 'all'));
      $('#event-editor').close(); setTab('dates'); toast('这个日子，记住了。');
    } catch(error) { toast(`保存未完成：${error.message || '请检查存储空间。'}`); }
    finally { $('#save-event').disabled = false; $('#end-period').disabled = false; }
  });
  $('#editor').addEventListener('cancel',event => { event.preventDefault(); closeDialog('editor'); });
  $('#entry-form').addEventListener('input',() => { if(!editingId) { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft,500); } });
  document.addEventListener('visibilitychange',() => { if(document.visibilityState === 'hidden' && $('#editor').open && !editingId) void saveDraft(); });
  $('#entry-form').addEventListener('submit',async event => {
    event.preventDefault();
    const value = draftValue(); value.title = value.title.trim(); value.body = value.body.trim();
    if(!value.body && !value.photos.length) return toast('写下一句话吧。');
    if(!validDate(value.date)) return toast('请选择有效的日期。');
    clearTimeout(draftTimer); $('#save-entry').disabled = true;
    try {
      await mutate(data => {
        const now = Date.now();
        if(editingId) { const entry = data.entries.find(item => item.id === editingId && !item.deleted); if(!entry || entry.author !== active) throw new Error('这篇日记已不存在'); if(isShared && entryContent(entry)!==editingBase) throw new Error('这篇日记已在另一处修改。编辑器里的文字保留着，请先复制，再重新打开核对。'); Object.assign(entry,value,{updated:now,example:false}); }
        else data.entries.push({...value,id:uid(),author:active,comments:[],likes:[],created:now,updated:now,example:false});
      });
      if(!editingId) { try { await write(`draft-${active}`,null); } catch { toast('日记已保存，但草稿未能清除。'); } }
      $('#editor').close(); setTab('diary'); toast('今天的记录，被好好收起来了。');
    } catch(error) { toast(`保存未完成：${error.message || '内容仍在编辑器中，请稍后重试。'}`); }
    finally { $('#save-entry').disabled = false; }
  });
  $('#detail-content').addEventListener('submit',async event => {
    if(event.target.id !== 'comment-form') return; event.preventDefault();
    const body = event.target.elements.comment.value.trim(); if(!body) return;
    const button = event.target.querySelector('button'); button.disabled = true;
    try { await mutate(data => { const entry = data.entries.find(item => item.id === openId && !item.deleted); if(!entry) throw new Error('日记已删除'); entry.comments.push({id:uid(),author:active,body,created:Date.now()}); entry.updated = Date.now(); }); showDetail(openId); toast('悄悄话留下了。'); }
    catch { toast('留言未保存，请稍后重试。'); button.disabled = false; }
  });
  $('#settings').addEventListener('input',()=>{$('#settings').dataset.dirty='true';});
  $('#settings').addEventListener('submit',async event => {
    event.preventDefault(); const form = event.target;
    const title = form.elements.title.value.trim(), people = [form.elements.person0.value.trim(),form.elements.person1.value.trim()], anniversary = form.elements.anniversary.value;
    if(!title || people.some(name => !name)) return toast('空间名称和两个人的称呼都要填哦。');
    if(anniversary && !validDate(anniversary)) return toast('请选择有效的纪念日。');
    try {
      await mutate(data => {
        const next={title,people,anniversary};
        if(!isShared) {Object.assign(data,next);return;}
        for(const field of ['title','anniversary']) if(next[field]!==settingsBase[field]) {
          if(data[field]!==settingsBase[field] && data[field]!==next[field]) throw new Error('同一项设置已在另一处修改，请重新打开页面核对。');
          data[field]=next[field];
        }
        for(const person of [0,1]) if(people[person]!==settingsBase.people[person]) {
          if(data.people[person]!==settingsBase.people[person] && data.people[person]!==people[person]) throw new Error('这个称呼已在另一处修改，请重新打开页面核对。');
          data.people[person]=people[person];
        }
      });delete form.dataset.dirty;document.activeElement?.blur();render();toast('这是属于你们的空间了。');
    } catch(error) {toast(`设置保存未完成：${error.message}`);}
  });
  $('#import-file').addEventListener('change',async event => {
    const file = event.target.files[0]; event.target.value = ''; if(!file) return;
    try {
      if(shared) {if(!confirm('合并这份加密备份？现有记录会保留，并行修改会列出供你选择。'))return;await shared.import(file);toast('加密备份已合并。');return;}
      if(file.size > 150*1024*1024) throw new Error('单次导入请小于 150 MB。');
      const backup = validateBackup(JSON.parse(await file.text()));
      if(!confirm(`导入 ${backup.entries.filter(entry => !entry.deleted).length} 篇日记和 ${backup.events.filter(event => !event.deleted).length} 条日期记录，并使用备份中的空间名称和称呼？现有独立记录会保留；同一条记录以更新时间较新的版本为准。`)) return;
      await mutate(data => { const events = mergeEvents(data.events,backup.events); const merged = new Map(data.entries.map(entry => [entry.id,entry])); backup.entries.forEach(entry => { const old = merged.get(entry.id); if(!old || entry.updated > old.updated) merged.set(entry.id,entry); }); Object.assign(data,{version:2,title:backup.title,people:backup.people,anniversary:backup.anniversary,entries:[...merged.values()],events}); });
      toast('备份已导入。');
    } catch(error) { toast(`导入未完成：${error.message}`); }
  });
  window.addEventListener('hashchange',() => { if(location.hash === '#diary') setTab('diary'); });
  channel?.addEventListener('message',async () => { if(document.querySelector('dialog[open]')) return; if(shared)await shared.changed();else {state = await read('state'); render();} });
}
async function start() {
  if(isShared) {
    shared=await initializeShared(snapshot=>{state=snapshot.state;active=snapshot.active;render();});
    state=shared.current.state;active=shared.current.active;
    const backupCard=$('#export').closest('.settings-card');
    backupCard.querySelector('p').textContent='保存一份加密的日记、留言和日期记录备份。恢复时需要空间恢复码；未发布的草稿仅留在本机。';
    backupCard.querySelector('.small').textContent='请另外保存恢复码。导入时会保留不同版本，供你们选择。';
    $('#export').textContent='导出加密备份';$('#import').textContent='合并加密备份';
    const localCard=$('#stats').closest('.settings-card');localCard.querySelector('strong').textContent='属于你们的共享空间';
    localCard.querySelector('p').textContent='蓝绿色的小空间，留住文字、悄悄话和重要的日期。保存后留意页面顶部的同步状态。';
    bindEvents();render();setTab('diary');
    if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
    return;
  }
  const request = indexedDB.open('little-days-local',1);
  request.onupgradeneeded = () => request.result.createObjectStore('data');
  db = await requestValue(request);
  db.onversionchange = () => db.close();
  state = await read('state'); if(!state) { state = sampleState(); await write('state',state); }
  else if(state.version === 1) { await mutate(data => { data.events ??= []; data.version = 2; }); }
  bindEvents(); render(); setTab('diary');
  if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}
start().catch(error => { $('.app-shell').hidden=false;$('#entries').innerHTML = empty('暂时无法打开本地存储',isShared?escape(error.message):'请使用普通浏览模式，并允许此网站保存数据。'); $('#new-entry').disabled = true; toast('浏览器存储不可用，请使用较新版本的 Safari 普通浏览模式。'); });
