# Roche 私人音乐服务

使用 NeteaseCloudMusicApiEnhanced 4.41.1。仅开放 /search 和 /song/url，免登录可播曲目；不存账号 Cookie，不转发音频文件。

## 部署
1. Vercel 用 GitHub 登录，导入 zhuzeyu0424/roche-plugins。
2. Root Directory 设为 music-service，Framework Preset 选 Other。
3. 环境变量新增 MUSIC_ACCESS_KEY，值设为你自己的随机长口令；不要写入公开仓库。
4. Deploy。完成后打开域名，应显示 Roche music 和 configured:true。
5. 在插件音乐源页填写域名及同一个口令。

请勿在 Vercel 设置网易云账号 Cookie。本版尚未提供账号登录。
当前验证：本地模拟请求测试。云端联网搜索、音频可用性及手机实际播放仍需部署后验证；不保证所有歌曲可播。
