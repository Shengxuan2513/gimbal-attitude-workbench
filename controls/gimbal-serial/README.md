# 云台串口控制源码
逐字节复制现有 gimbal-serial，未改轨迹、协议或停止逻辑。
安装：`python -m pip install -r requirements.txt`
离线测试：`python -m unittest discover -s tests -v`
查看参数：`python test_bgc.py --help`、`python periodic_motion.py --help`。
所有运动脚本默认 dry-run；真实运动需显式真实模式、端口及确认参数，先核对设备及物理急停。仓库和页面不会自动启动云台。ACK 不代表机械停止。
传感器原始数据由厂家上位机采集；控制日志派生角度不能当作独立姿态真值。
