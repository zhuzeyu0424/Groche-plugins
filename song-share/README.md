# 分享歌曲 0.9.0

[安装或覆盖更新](https://raw.githubusercontent.com/zhuzeyu0424/Groche-plugins/main/song-share/plugin.json?v=0.9.0)

- **FM** 使用圆形唱片。音频实际播放时转动，暂停时停在原处。一起听显示当前会话的人设和角色头像。
- **Search** 显示可点击的歌手和歌曲推荐。点选后在当前选中的 NetEase、QQ Music 或 Apple Music 中搜索。
- **Playlists → Shared** 从所选角色的聊天历史读取歌曲卡片。长聊天可以点 **Earlier songs** 继续向前找。
- **Playlists → New mix** 手动调用一次 Roche 当前配置的聊天模型。可以关闭「参考最近聊天」。插件在所选音乐源核对歌名、歌手和专辑封面，最多保存 8 首匹配的歌曲，每个角色最多 12 张本机歌单。

生成歌单使用 Roche 配置的 API 配额。模型找到的歌曲仍受音乐源的地区、版权和会员权限限制。Apple Music 仍使用官方嵌入播放器，整曲和后台播放取决于设备和账号。

[固定回退至 0.8.0](https://raw.githubusercontent.com/zhuzeyu0424/Groche-plugins/main/song-share/releases/0.8.0/plugin.json)
