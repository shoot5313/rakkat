import { validDate, validateEvents } from './dates.js';
export const moods = ['晴朗','想你','平静','开心','有点累','小情绪'];
export const validReplyTo = (value,commentId) => value == null || (typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value) && value !== commentId);
export function validateBackup(data) {
  const string = (value,max) => typeof value === 'string' && value.length <= max;
  const id = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value);
  const person = value => value === 0 || value === 1;
  const time = value => Number.isFinite(value) && value >= 0 && value <= Date.now()+86400000;
  const photo = value => typeof value === 'string' && value.length <= 6000000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(value);
  if(!data || data.format !== 'little-days-backup' || ![1,2].includes(data.version) || !string(data.title,24) || !data.title.trim() || !Array.isArray(data.people) || data.people.length !== 2 || !data.people.every(name => string(name,12) && name.trim()) || !(data.anniversary === '' || validDate(data.anniversary)) || !Array.isArray(data.entries) || data.entries.length > 10000) throw new Error('这不是有效的rakkat备份。');
  const ids = new Set();
  const entries = data.entries.map(entry => {
    if(!entry || !id(entry.id) || ids.has(entry.id) || !person(entry.author) || !validDate(entry.date) || !string(entry.title,80) || !string(entry.body,20000) || !moods.includes(entry.mood) || !Array.isArray(entry.photos) || entry.photos.length > 6 || !entry.photos.every(photo) || !Array.isArray(entry.likes) || entry.likes.length > 2 || new Set(entry.likes).size !== entry.likes.length || !entry.likes.every(person) || !Array.isArray(entry.comments) || entry.comments.length > 10000 || !time(entry.created) || !time(entry.updated)) throw new Error('备份中的日记格式不正确，尚未导入。');
    if(entry.editedAt !== undefined && !time(entry.editedAt))throw new Error('备份中的日记编辑时间不正确。');
    ids.add(entry.id);
    const comments = entry.comments.map(comment => {
      if(!comment || !id(comment.id) || !person(comment.author) || !string(comment.body,2000) || !time(comment.created) || !validReplyTo(comment.replyTo,comment.id)) throw new Error('备份中的留言格式不正确。');
      return {id:comment.id,author:comment.author,body:comment.body,created:comment.created,...(comment.replyTo ? {replyTo:comment.replyTo} : {})};
    });
    return {id:entry.id,author:entry.author,date:entry.date,title:entry.title,body:entry.body,mood:entry.mood,photos:entry.photos,comments,likes:entry.likes,created:entry.created,updated:entry.updated,...(entry.editedAt !== undefined ? {editedAt:entry.editedAt} : {}),example:entry.example === true,deleted:entry.deleted === true};
  });
  const events = validateEvents(data.version === 1 && data.events === undefined ? [] : data.events);
  return {title:data.title,people:data.people,anniversary:data.anniversary,entries,events};
}
