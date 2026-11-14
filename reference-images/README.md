# 锁脸多图参考 0.6.0

[安装或更新](https://raw.githubusercontent.com/zhuzeyu0424/Groche-plugins/main/reference-images/plugin.json?v=0.6.0)

保持原插件 ID `roche-reference-plus` 和本机参考库。已有插件请用此地址安装更新，不要先卸载、删除网站数据。旧 Supabase 下载文件保持原样，不会迫使其他人更新。

## 我的参考放在哪里

进入 Roche「人设库 → 编辑人设」，在人设描述旁点「多图参考」，上传并启用、保存。也可从插件内「为谁设置 → 我的人设」进入。新建人设需要先在 Roche 保存一次，取得档案 ID。

角色的「线下的我」选择「跟随当前聊天人设」后，按**本次发起生图的聊天**选择 user：优先读取聊天设置的人设，其次 Roche 的全局当前人设。换聊天或人设不需要重复上传图片。为兼容已有配置，旧版明确选择的固定 user 会保留；需要自动跟随时改一次即可。此功能仅用于线下，线上角色单人照片不会追加 user 参考。

有明确的本轮出镜信息时，只给出镜的人附图；风景、物品、仅其他人物不附这两人的脸。原聊天模型会收到人物标记说明，不会为识别出镜人物另调用一次模型。人物标记仍可能出错，生成记录可核对最终提交的图和提示词。

## 四张图与锁脸的一张图

原生锁脸管理选中的一张是与 Roche 连接的入口，不代表实际只提交一张。

- 单人：提交该人已保存的全部人物参考，最多四张。
- 双人：各自优先从主参考选两张，总计最多四张人物图；可另加角色的一张画风图。
- 主参考可多选；辅助参考并不是禁用。接口成功也不能证明模型同等采用了每张图。

为了控制双人接口兼容性与输入量，本版没有盲目扩大双人图片张数，也不做失败后的自动付费重试。

## 选图与外貌配置

前两张主参考优先选**同一外貌、不同角度**的清晰图，例如正面和 3/4 侧面。其余可用另一角度和半身图。避免四张几乎相同的近距离自拍、广角大头照，或把不同骷髅面罩款式混在同一套里。不同面罩请保存成不同造型预设。

固定外貌只写长期特征：肤色、眼睛、脸型、发色、体型、身高、纹身、必要的面罩特征。衣服、动作、表情和灯光留给本轮场景。原绘图配置如果写死了服装、表情、镜头或发型摆放，也需要同步删去冲突的固定要求。双方的外貌分别保存到自己的参考设置。

「自然变化」会提示模型重新生成表情、姿势、面罩褶皱，不照搬参考头部。新增可选身高字段和共同镜头/透视、头身比例规则；**这些是提示词约束，不是模型的精确几何控制或锁脸强度参数**。不要把体型差距写成头部大小差距，也不要强制两人头部像素大小相同。

可用于全局绘图配置的简短规则：

```text
Natural everyday photography. Preserve each visible person's own identity and distinctive physical features. Use references for appearance, not their crop, pose, fixed expression or clothing. Render relaxed, scene-appropriate expressions and realistic head-to-body proportions. Place everyone in one consistent camera perspective; relative size follows body size, posture and distance from the camera. Clothing and lighting follow the current scene and weather. Do not blend identities or paste reference heads.
```

本版已自动加入上述核心约束，不必重复粘贴。文字配置仍无法保证模型每张图都准确自然。

## 保存与回退

参考图和预设保存在当前浏览器的插件 IndexedDB 中，不包含 API 密钥。换设备前请用插件里的「参考设置备份」单独导出，普通 Roche 备份不包含此图片库。

[0.5.1 固定回退版本](https://raw.githubusercontent.com/zhuzeyu0424/Groche-plugins/main/reference-images/releases/0.5.1/plugin.json)

回退保留同一插件 ID，不需要清除参考库。旧版保存设置时不会理解新版的自动人设来源和身高字段，建议先导出参考备份。

## 验证范围

WebKit 手机/平板/桌面布局，真实原生 ContactEdit、PersonaEdit、锁脸绑定和生图保存流程的隔离夹具；自动/固定人设、单人/双人/无人场景、预设恢复、图片返回与 ImgBB 上传衔接、接口失败不重发均有自动检查。当前公开 Roche 的核心程序与已核验接口快照一致。

测试使用模拟生图与上传接口，没有真实付费生图，没有把测试照片、聊天或凭据发送到服务商。实际手机和模型生成质量需要用户使用后反馈。
