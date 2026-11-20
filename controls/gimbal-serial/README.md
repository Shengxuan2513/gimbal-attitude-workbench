# 云台控制与交互控制台

更新：2026-11-20，代码基线 main a6ac819。本轮只同步说明，未改协议、轨迹或停止逻辑。部分早期脚本由本机项目复制，来源散列见 docs/source-provenance.json；后续 gimbal_console.py 已在PR #4同步，不能把原始快照清单当成整个目录最新逐文件清单。

## 安装与离线检查
在此目录执行：
```
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
python gimbal_console.py --help
```
默认 dry-run，程序模拟串口，不连接设备。可运行 python gimbal_console.py 进入默认离线交互菜单。测试文件针对安全停止和既有运动脚本，之前13项离线通过并不覆盖全部新增轨迹的实机性能。

## 功能
- gimbal_console.py：点动、单轴往返、5/7周期及自定义周期；同相正弦、画圆/椭圆、8字、多谐波模式和参数编辑。代码中“真随机”指随机化轨迹参数，不是随机外力干扰；可复现实验应保存实际参数/日志。
- test_bgc.py、test_three_axes.py：单轴/逐轴测试；periodic_motion.py、periodic_motion_7cycles.py：周期轨迹。
- read_com4.py：保留历史文件名的监测脚本，不代表应连接COM4；gimbal_safety.py提供保护与停止处理。

所有真实运动必须显式真实模式、端口及确认参数；具体以各脚本 --help 为准。程序限幅不等于机械绝对安全范围。先人工核对端口、安装、线缆、负载、固件限位和急停；本说明及工作台不自动执行运动。

初始停止失败禁止运动，停止/通信失败触发锁定，异常清理仍尝试关串口；ACK仅代表协议应答，不代表机械已停。板上BGC自身增稳与离线算法分开归因。

## 日志含义与工作台
控制日志至少包含 elapsed_s、yaw_position_deg、roll_position_deg、pitch_position_deg，三轴rpm可选。字段表示指令/派生轨迹，不是编码器实测。原始机体系IMU由厂家上位机记录，不由这些控制脚本自动采集。

工作台PR #5支持把同次指令日志叠加到六轴曲线，调整时间偏移和起点姿态；不等于硬件同步。相对指令RMSE不能作为姿态精度。电机实际位置/速度回传未接入，暂无基于该反馈的闭环误差验收。
