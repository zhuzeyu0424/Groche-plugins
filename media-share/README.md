# 相册与拍摄 0.1.0

在 Roche 插件管理安装本目录的 plugin.json。刷新后，在单人聊天的加号菜单打开「照片与视频」。这是新增入口，不替换原生相册/拍摄。

- 一次发送一张照片或一个短视频；最多 25 MB、视频 30 秒。
- 预览不调用模型，点击「识别并发送」才调用一次识图。失败不自动重试。
- 角色下次回复读取视觉描述。视频按时间抽取 4 帧，不理解音频，不保证捕获所有动作。
- 拍摄需要 HTTPS 和相机权限；可用系统拍摄入口录像。
- iPhone 网页相册可能只交出 Live Photo 静态照片。可先在照片 App「存储为视频」，再选取视频；也支持同名照片和 MOV 一起选入。并非原生 Live Photo 完整导入。

## 识图 API

默认沿用 Roche 聊天 API，所选模型及服务必须支持 image_url 图片输入。若聊天模型不能看图，在「识图设置」选「独立识图 API」，填写完整 chat/completions HTTPS 地址、支持图片的模型 ID 与 API Key，然后保存。

Gemini 的官方兼容接口可用：`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`。模型选择账号当前可用的视觉 Flash 模型；密钥来自 Google AI Studio。参考 https://ai.google.dev/gemini-api/docs/openai 。第三方站点需确认支持图片输入和浏览器跨域调用。

## 保存与测试范围

照片经压缩保存，视频保存所选文件；识别时上传压缩画面到你配置的 API。媒体保存在本浏览器独立 IndexedDB，不上传图床，不跨设备同步，Roche 普通备份不包含本媒体库。请保留相册里的原文件。清除网站数据会丢失媒体，卡片只保留预览图和角色可读描述。

已通过模拟 Roche 接口的 WebKit 照片发送、保存回读、识别失败、层级和清理测试；未在真实 iPhone Roche 中端到端验证。真实相机、HEIC/MOV 解码和 Live Photo 选择取决于设备浏览器。
