# 分享歌曲 0.7.0

Apple Music 卡片和「发现／我们的歌」里的播放按钮会在 Roche 内打开 Apple 官方播放器。请在 Apple 播放器里使用已有会员登录、点播放，无需 Apple Developer 账号，不需要把账号、密钥或令牌交给插件。插件不再请求 Apple 的旧试听直链；未登录、登录状态没带进来或曲库受限时，Apple 自己的控件可能仍只播试听。这时可从窗口底部在 Apple Music 打开。

Apple 播放器负责登录与播放，Roche 不读取它的真实进度、会员状态和歌词；角色也不能控制它。QQ 和网易云的播放及「一起听」继续使用原来的播放器和配置。关闭 Apple 播放器窗口会结束该播放器；切到别的 App 或锁屏时是否继续播放，受系统和浏览器影响，需要在实际使用的 iPhone 环境验证。如果你需要可靠的锁屏播放，从窗口底部用系统 Apple Music 打开。

安装或更新：<https://raw.githubusercontent.com/zhuzeyu0424/Groche-plugins/main/song-share/plugin.json?v=0.7.0>

固定旧版：<https://raw.githubusercontent.com/zhuzeyu0424/Groche-plugins/main/song-share/releases/0.6.0/plugin.json>
