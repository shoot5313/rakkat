// Calendar-only dates use UTC for arithmetic, independent of daylight saving time.
export const eventKinds = { meeting:'见面', period:'经期', anniversary:'纪念日', other:'其他' };
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1900-01-01' && value <= '9999-12-31' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}
export function daysBetween(start,end) { return Math.round((Date.parse(end)-Date.parse(start))/86400000); }
export function shiftDate(value,days) { return new Date(Date.parse(value)+days*86400000).toISOString().slice(0,10); }
export function anniversaryInYear(value,year) {
  const candidate = `${String(year).padStart(4,'0')}-${value.slice(5)}`;
  // A February 29 anniversary is observed on February 28 in non-leap years.
  return validDate(candidate) ? candidate : `${year}-02-28`;
}
export function nextOccurrence(event,day) {
  if(event.deleted) return null;
  if(!event.yearly) return event.start >= day ? event.start : null;
  const year = Math.max(Number(day.slice(0,4)),Number(event.start.slice(0,4)));
  const date = anniversaryInYear(event.start,year);
  return date >= day ? date : year < 9999 ? anniversaryInYear(event.start,year+1) : null;
}
export function occursOn(event,day,today) {
  if(event.deleted || day < event.start) return false;
  if(event.yearly) return day === anniversaryInYear(event.start,Number(day.slice(0,4)));
  const end = event.end || (event.kind === 'period' ? today : event.start);
  return day >= event.start && day <= end;
}
export function calendarDays(month) {
  const first = `${month}-01`;
  const weekday = (new Date(first).getUTCDay()+6)%7;
  return Array.from({length:42},(_,index) => shiftDate(first,index-weekday));
}
export function eventInputError(value,events,today,editingId = null) {
  if(!Object.hasOwn(eventKinds,value.kind)) return '请选择记录类型。';
  if(!validDate(value.start) || (value.end && !validDate(value.end))) return '请选择有效的日期。';
  if(value.end && value.end < value.start) return '结束日期不能早于开始日期。';
  if(value.yearly && (value.kind !== 'anniversary' || value.end)) return '每年重复的纪念日只能选择一个日期。';
  if(value.kind === 'period') {
    if(value.subject !== 0 && value.subject !== 1) return '请选择经期记录属于谁。';
    if(value.start > today || value.end > today) return '经期只记录已发生的日期。';
    const end = value.end || '9999-12-31';
    const overlap = events.some(event => !event.deleted && event.id !== editingId && event.kind === 'period' && event.subject === value.subject && value.start <= (event.end || '9999-12-31') && event.start <= end);
    if(overlap) return '这段日期和已有经期记录重叠，请先调整或结束已有记录。';
  }
  return '';
}
export function validateEvents(events) {
  if(!Array.isArray(events) || events.length > 10000) throw new Error('备份中的纪念日格式不正确。');
  const ids = new Set();
  return events.map(event => {
    if(!event || typeof event.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(event.id) || ids.has(event.id) || !Object.hasOwn(eventKinds,event.kind) || ![0,1].includes(event.author) || typeof event.title !== 'string' || event.title.length > 80 || typeof event.note !== 'string' || event.note.length > 2000 || !validDate(event.start) || typeof event.end !== 'string' || (event.end && (!validDate(event.end) || event.end < event.start)) || typeof event.yearly !== 'boolean' || (event.yearly && (event.kind !== 'anniversary' || event.end)) || (event.kind === 'period' ? ![0,1].includes(event.subject) : event.subject !== null) || !Number.isFinite(event.created) || !Number.isFinite(event.updated) || event.created < 0 || event.updated < event.created || event.updated > Date.now()+86400000) throw new Error('备份中的纪念日或经期记录格式不正确。');
    ids.add(event.id);
    return {id:event.id,kind:event.kind,author:event.author,subject:event.subject,title:event.title,note:event.note,start:event.start,end:event.end,yearly:event.yearly,created:event.created,updated:event.updated,deleted:event.deleted === true};
  });
}
export function mergeEvents(current,incoming) {
  const merged = new Map(current.map(event => [event.id,event]));
  incoming.forEach(event => { const old = merged.get(event.id); if(!old || event.updated > old.updated) merged.set(event.id,event); });
  const result = [...merged.values()];
  const periods = result.filter(event => !event.deleted && event.kind === 'period').sort((a,b) => a.start.localeCompare(b.start));
  for(const subject of [0,1]) {
    const own = periods.filter(event => event.subject === subject);
    for(let index=1;index<own.length;index++) if(own[index].start <= (own[index-1].end || '9999-12-31')) throw new Error('导入后会出现重叠的经期记录，未导入任何内容。请先调整日期。');
  }
  return result;
}
