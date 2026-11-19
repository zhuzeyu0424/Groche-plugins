# 分享歌曲 0.8.0

[安装或覆盖更新](https://raw.githubusercontent.com/zhuzeyu0424/Groche-plugins/main/song-share/plugin.json?v=0.8.0)

- **FM** 显示当前歌曲、进度、歌词和一起听状态。切到其他页继续用迷你播放器。
- **Search** 在搜索框下切换 NetEase、QQ Music 和 Apple Music。点歌名播放，点心形收藏。更多菜单可设为下一首、加入队尾或发到聊天。
- **Likes** 显示本机收藏。**Playlists** 显示所选角色在最近聊天里发过的歌曲。
- 点「Play all」可用当前列表替换该聊天的队列。队列打开后可上移或移除待播歌曲。歌曲条目保存在本机，重新打开时由你决定何时开始播放。
- 右上角「···」进入音乐设置或粘贴分享链接。可以沿用现有 QQ 扫码授权和网易云服务，旧歌曲卡片可以继续使用。

网易云明确返回试听时会提示切源或去原平台。Apple Music 使用官方嵌入播放器，排到 Apple 歌曲时要手动点播。会员整曲可用性由 Apple 播放器决定。

用隔离的 WebKit 测试了三种来源、收藏、待播、分享、歌词与角色权限。实际账号播放与手机后台行为需在设备上确认。

[固定回退至 0.7.1](https://raw.githubusercontent.com/zhuzeyu0424/Groche-plugins/main/song-share/releases/0.7.1/plugin.json)
