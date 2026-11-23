# 分享歌曲 0.9.1

[安装或覆盖更新](https://raw.githubusercontent.com/zhuzeyu0424/Groche-plugins/main/song-share/plugin.json?v=0.9.1)

在 Roche 的「插件 App 管理」粘贴地址，安装后刷新 Roche。

- 普通私聊不加载发歌工具。在 Roche 已启用后端模式且本轮没有其他插件工具时，回复可以走后端并发送锁屏推送。
- 开启当前聊天的「允许角色分享歌曲」后，直接说「给我发首歌」「推荐一首适合晚上的歌」或「帮我搜歌」，这一轮才加载发歌工具。发歌这一轮需要页面继续运行。
- 已经开始一起听时，说「看歌词」「切下一首」或「暂停」可以让角色按当前权限操作。聊其他话题时，角色仍能看到播放状态。

角色在普通聊天中主动发卡或在锁屏时搜歌仍需后端能够执行歌曲工具。

## 播放和歌单

- **FM** 的圆形唱片随实际播放转动。一起听显示当前会话的人设和角色头像。
- **Search** 的推荐歌手和曲目可以用当前选中的 NetEase、QQ Music 或 Apple Music 搜索。
- **Playlists → Shared** 可以翻阅角色发过的歌曲。
- **Playlists → New mix** 手动调用一次 Roche 的聊天模型，并在所选音乐源核对歌名、歌手和专辑封面。最多保存 8 首匹配的歌曲，每个角色最多 12 张本机歌单。

生成歌单使用 Roche 配置的 API 配额。歌曲可播放的范围取决于音乐源、地区和账号。Apple Music 使用官方嵌入播放器。

[固定回退至 0.9.0](https://raw.githubusercontent.com/zhuzeyu0424/Groche-plugins/main/song-share/releases/0.9.0/plugin.json)
