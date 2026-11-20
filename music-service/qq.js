'use strict';
// Only login and read/playback operations are exposed. Never import the package root (starts Koa).
const { handleRequest } = require('@yakult-green-tea/qq-music-api/serverless');
const ID = /^[A-Za-z0-9]{1,32}$/;
class QqFailure extends Error { constructor(status, message) { super(message); this.status = status; } }
const text = (v, n = 100) => String(v ?? '').trim().slice(0, n);
function httpsMedia(value) {
  let u; try { u = new URL(value); } catch { throw new QqFailure(422, 'QQ 音乐未返回可播放链接'); }
  if (u.protocol === 'http:') u.protocol = 'https:';
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !/(^|\.)qq\.com$/i.test(u.hostname))
    throw new QqFailure(422, 'QQ 音乐返回的音频地址不受支持');
  return u.href;
}
async function numericSongInfo(value, request) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new QqFailure(400, 'QQ 歌曲编号无效');
  // The SDK route requires a MID. QQ's public catalog accepts old IDs as numbers.
  const url = new URL('https://u.y.qq.com/cgi-bin/musicu.fcg');
  url.search = new URLSearchParams({ format: 'json', data: JSON.stringify({
    comm: { ct: 24, cv: 0 },
    songinfo: { module: 'music.pf_song_detail_svr', method: 'get_song_detail_yqq', param: { song_type: 0, song_id: id } }
  }) });
  let data;
  try {
    const response = await request(url, {
      headers: { Referer: 'https://y.qq.com/' }, redirect: 'error', signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) throw Error('QQ song lookup failed');
    data = (await response.json()).songinfo;
  } catch {
    throw new QqFailure(502, '暂时查不到旧卡片的歌曲详情，请稍后再试');
  }
  const song = data?.data?.track_info;
  if (data?.code !== 0 || Number(song?.id) !== id || !ID.test(text(song?.mid, 32)))
    throw new QqFailure(422, '这张旧歌曲卡片无法解析，请重新搜索这首歌');
  return song;
}
async function qq(route, body, token, env, invoke = handleRequest, request = fetch) {
  if (!env.QQ_SESSION_SECRET || env.QQ_SESSION_SECRET.length < 32)
    throw new QqFailure(503, '请在 Vercel 添加 QQ_SESSION_SECRET（至少 32 位随机字符），然后重新部署音乐服务');
  async function call(path, args = {}, method = 'GET', useSession = true) {
    const u = new URL(path, 'https://roche-music.internal');
    if (method === 'GET') u.search = new URLSearchParams(args).toString();
    const r = await invoke(new Request(u, { method,
      headers: { ...(token && useSession ? { 'X-QQ-Session': token } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(args) } : {}) }), {
      QQ_SESSION_SECRET: env.QQ_SESSION_SECRET, QQ_SESSION_SECRET_PREVIOUS: env.QQ_SESSION_SECRET_PREVIOUS,
      QQ_PLAYBACK_HINTS_ENABLED: '1', QQ_PTLOGIN_HTTP_ENABLED: '1'
    });
    const d = await r.json();
    if (!r.ok) {
      if (path === '/search' && d.errorKey === 'search.rejected')
        throw new QqFailure(502, 'QQ 曲库本次拒绝搜索' + (Number.isSafeInteger(d.upstreamCode) ? '（' + d.upstreamCode + '）' : '') + '，未发送卡片；可稍后手动重试');
      const hints = { 401: 'QQ 登录已过期，请重新扫码', 429: 'QQ 请求过于频繁，请稍后再试', 501: '当前音乐服务不支持这项 QQ 请求', 502: 'QQ 音乐暂时无法连接，请稍后再试' };
      throw new QqFailure(r.status, hints[r.status] || 'QQ 音乐请求未完成（' + r.status + '）');
    }
    return d;
  }
  if (route === '/qq/channels') return call('/login/channels');
  if (route === '/qq/qr/start') {
    if (!['qq', 'wechat'].includes(body.channel)) throw new QqFailure(400, '请选择 QQ 或微信扫码');
    const key = (await call('/login/qr/key', { channel: body.channel })).data?.unikey;
    if (!key) throw new QqFailure(502, 'QQ 二维码创建失败，请稍后重试');
    const qr = (await call('/login/qr/create', { key })).data?.qrimg;
    if (typeof qr !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(qr))
      throw new QqFailure(502, 'QQ 二维码图片格式不正确');
    return { code: 200, data: { key, qrimg: qr } };
  }
  if (route === '/qq/qr/check' || route === '/qq/qr/cancel') {
    const key = text(body.key, 16000);
    if (!key || /[\r\n]/.test(key)) throw new QqFailure(400, '二维码已失效，请重新获取');
    const d = await call(route.endsWith('check') ? '/login/qr/check' : '/login/qr/cancel', { key });
    const session = d.code === 803 ? String(d.cookie || '').match(/(?:^|;\s*)qqmusic_session=([^;]+)/)?.[1] : '';
    if (d.code === 803 && !session) throw new QqFailure(502, '授权已完成，但未取得登录会话，请重新扫码');
    return { code: 200, data: { state: Number(d.code), ...(session ? { token: session } : {}),
      ...(d.failureHint?.key ? { hint: text(d.failureHint.key) } : {}) } };
  }
  if (route === '/qq/status') {
    if (!token) return { code: 200, data: { loggedIn: false } };
    const d = await call('/login/status');
    return { code: 200, data: { loggedIn: !!d.data?.profile } };
  }
  if (route === '/qq/refresh') {
    if (!token) throw new QqFailure(401, '请先扫码登录 QQ 音乐');
    const d = await call('/login/refresh', {}, 'POST');
    return { code: 200, data: { token: d.data?.token || token, expiresAt: d.data?.expiresAt } };
  }
  if (route === '/qq/search') {
    const keyword = text(body.query, 60); if (keyword.length < 2) throw new QqFailure(400, '请填写歌名或歌手');
    // The catalog is public. Do not route a keyword search through the logged-in Android branch:
    // that branch can return an empty list even when the public catalog has matching songs.
    const d = await call('/search', { keyword, type: 'song', limit: '12', page: '1' }, 'GET', false);
    if (!Array.isArray(d.items)) throw new QqFailure(502, 'QQ 搜索结果格式不正确');
    const songs = d.items.slice(0, 12).flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const s = item.songInfo || item; const mid = text(s.mid || s.songmid, 32);
      const title = text(s.title || s.name || s.songname);
      if (!ID.test(mid) || !title) return [];
      const album = text(s.album?.mid || s.albummid, 32);
      return [{ title, artist: (Array.isArray(s.singer) ? s.singer : []).map(a => text(a?.name)).filter(Boolean).join(' / '),
        url: 'https://y.qq.com/n/ryqq/songDetail/' + mid,
        artwork: ID.test(album) ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + album + '.jpg' : '',
        qqMid: mid, qqMedia: text(s.file?.media_mid, 32), verified: true }];
    });
    if (d.items.length && !songs.length) throw new QqFailure(502, 'QQ 返回了搜索数据，但歌曲格式无法读取，请更新音乐服务');
    return { code: 200, data: songs };
  }
  if (route === '/qq/detail') {
    const mid = text(body.mid, 32); if (!ID.test(mid)) throw new QqFailure(400, '这张歌曲卡片没有有效的 QQ 歌曲编号');
    const numeric = /^\d+$/.test(mid);
    const s = numeric ? await numericSongInfo(mid, request) :
      (await call('/getSongInfo/' + mid, {}, 'GET', false)).response?.songinfo?.data?.track_info;
    if (!s || (!numeric && text(s.mid, 32) !== mid)) throw new QqFailure(422, 'QQ 未返回这张卡片对应的歌曲详情');
    const album = text(s.album?.mid, 32);
    return { code: 200, data: { qqMid: text(s.mid, 32), qqMedia: text(s.file?.media_mid, 32),
      artwork: ID.test(album) ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + album + '.jpg' : '' } };
  }
  if (route === '/qq/lyrics') {
    let mid = text(body.mid, 32); if (!ID.test(mid)) throw new QqFailure(400, '歌曲编号无效');
    if (/^\d+$/.test(mid)) {
      mid = text((await numericSongInfo(mid, request)).mid, 32);
    }
    const d = await call('/getLyric', { songmid: mid }, 'GET', false);
    if (d.response?.code !== 0) throw new QqFailure(502, 'QQ 本次没有返回歌词，可稍后手动重试');
    return { code: 200, data: { lyric: typeof d.response.lyric === 'string' ? d.response.lyric.slice(0, 80000) : '' } };
  }
  if (route === '/qq/play') {
    if (!token) throw new QqFailure(401, '先在「设置 → QQ 音乐账号」扫码登录');
    let mid = text(body.mid, 32), media = text(body.media, 32);
    if (!ID.test(mid)) throw new QqFailure(400, '这张歌曲卡片没有有效的 QQ 歌曲编号');
    // Older cards use the numeric song ID. Resolve it to the correct song MID and media MID.
    if (/^\d+$/.test(mid)) {
      const s = await numericSongInfo(mid, request);
      mid = text(s.mid, 32); media = text(s.file?.media_mid, 32);
    }
    const d = await call('/getMusicPlay/' + mid, { quality: '128', ...(ID.test(media) ? { mediaId: media } : {}) });
    const entry = d.data?.playUrl?.[mid];
    if (!entry?.url || entry.error) throw new QqFailure(422, 'QQ 未提供这首歌的完整音频；请在 QQ 音乐确认播放权限，或换一首歌');
    if (entry.preview) throw new QqFailure(422, 'QQ 仅返回试听片段，本次没有切换为试听');
    if (entry.ekey || /\.(mgg|mflac|qmc\w*)\b/i.test(entry.url)) throw new QqFailure(422, '这首歌返回加密音频，请在 QQ 音乐打开');
    return { code: 200, data: { url: httpsMedia(entry.url), label: 'QQ 音乐 · 账号播放' } };
  }
  throw new QqFailure(404, '未找到音乐服务接口');
}
module.exports = { qq, QqFailure };
