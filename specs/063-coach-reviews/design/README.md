# 063 屏幕稿参照（2026-11-09 定稿）

前台页面的定稿稿，纯静态 HTML，浏览器直接打开即可。实装时**结构、文案、间距、配色以这里为准**；示例数据（教练名字、分数、128/19/523 等数字）一律换成接口真数据。

| 文件 | 页面 | 电脑 / 手机 |
|---|---|---|
| `home.html` | 首页 | 同一文件，720px 以下为手机版 |
| `list.html` | 全部教练（列表、搜索、筛选） | 同上 |
| `coach.html` | 教练页（总分、四项、资料、点评） | 同上 |
| `login.html` | 手机号登录 | 同上 |
| `write.html` | 写点评（首次，含被拦截提示） | 同上 |
| `report.html` | 举报点评（底部弹层） | 同上 |
| `submit.html` | 提交一位教练 | 同上 |
| `site.css` | 除首页外各页共用的样式与设计变量 | — |

`img/` 下四张照片是**占位**（Wikimedia Commons 公有领域，美军力量举比赛），上线前换成 David 提供的国内实拍：
- `hero.jpg`：Georgia Guardsman Breaks State Powerlifting Record…（US Air Force，Public domain）
- `squat.jpg`：A U.S. Marine with the Camp Pendleton Varsity Powerlifting Team performs a squat…（Cpl. Kenneth Jasik，Public domain）
- `plates.jpg`：Powerlifting 140927-A-EG775-585（Sgt. Spencer Rhodes，Public domain）
- `hall.jpg`：IMCOM Powerlifting Championship (8148597)（Sgt. 1st Class Abel Aungst，Public domain）

地图在稿里是占位框；实装接高德地图（见 SPEC 增补 §A3）。管理后台不在这里，按 plan-web 现有浅色后台做（SPEC §5）。
