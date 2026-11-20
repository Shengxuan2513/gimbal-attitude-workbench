# 六轴鲁棒姿态估计算法主方案（无磁力计 ESKF + 双侧白化 Huber）

版本：六轴方案与实现状态 1.1　更新：2026-11-20　代码基线：main a6ac819（PR #5）

> **当前状态**：src/filters/sixAxisEskf.ts 已接入 A0 标准一次 ESKF 与 A4 双侧白化 Huber IRLS ESKF，接收 WT61PC 无磁六轴输入。旧位置角 KF 和旧 IMU 占位接口仍保留，不能以占位接口推断六轴实现不存在。本文件同时包含数学目标规格和实现状态，已实现不等于已完成严格数学及独立真值实测验收。原始资料加补充修订构成设计依据，不声称每个工程选值都出自原 PDF。

阅读标记说明：
- `【保留】`：沿用原 PDF 与《补充审阅稿 1.0》的核心研究目标与数学框架。
- `【修订 6X-Mxx】`：针对 WT61PC 无磁力计硬件现实，将九轴主模型修订为六轴主配置。
- `【新增 6X-Nxx】`：在六轴无磁约束下新增的初始化、可观性、状态命名与工程边界约定。

---

## 一、研究目标与六轴主配置边界

1. **【保留】研究问题**：在同一名义状态模型、同一原始输入、同一初始化与同一基础噪声参数下，对比一次标准 ESKF、迭代二次损失 ESKF 与双侧白化 Huber 鲁棒 ESKF，验证 Huber 调权在异常比力／角速度观测下能否抑制姿态估计偏差而不显著损害正常工况精度。
2. **【修订 6X-M01】六轴主配置输入与观测维度**：
   - 本配置仅使用机体系三轴角速度 $\omega_m^b \in \mathbb{R}^3$（`rad/s`）与机体系三轴比力 $f_m^b \in \mathbb{R}^3$（`m/s²`）。
   - **无磁力计输入**：观测维度固定为 $m = 3$，观测向量仅保留比力块 $z = f_m^b$，观测雅可比仅保留加速度计块。
3. **【保留】适用限制**：基础比力观测模型假设平动惯性加速度 $a_s^n$ 较小且安装杆臂效应已补偿或可忽略；去重力后的“线加速度”不得直接代入 $h(q)$；显著动态比力与陀螺故障需通过边界测试验证，不得宣称鲁棒权重已自动估计位置、速度或时间偏差。

---

## 二、坐标系、四元数与状态约定

| 项目 | 本方案约定（待硬件标定核实） |
| :--- | :--- |
| 导航系 $n$ | 右手 ENU：X 东、Y 北、Z 上；重力向量 $g^n = [0, 0, -g_0]^T$（$g_0 \approx 9.80665\,\text{m/s}^2$） |
| 机体系 $b$ | 右手 FLU：X 前、Y 左、Z 上 |
| 旋转方向 | $R(q)$ 将机体系向量变换到导航系：$v^n = R(q)v^b$ |
| 四元数约定 | Hamilton 乘法，标量在前 $q = [q_w, q_x, q_y, q_z]^T$，单位范数 |
| 误差注入 | 右乘局部误差：$q = \bar{q} \otimes \operatorname{Exp}_q(\delta\theta)$，$b_g = \bar{b}_g + \delta b_g$ |
| 6 维误差顺序 | $\delta x = [\delta\theta_x, \delta\theta_y, \delta\theta_z, \delta b_{gx}, \delta b_{gy}, \delta b_{gz}]^T \in \mathbb{R}^6$ |
| 展示欧拉角 | ZYX 顺序 $R = R_z(\psi)R_y(\theta)R_x(\phi)$（仅用于界面展示，内部递推全程使用四元数） |

四元数指数映射：
$$
\operatorname{Exp}_q(\phi) = \left[\cos\frac{\alpha}{2},\; \frac{\sin(\alpha/2)}{\alpha}\phi^T\right]^T, \qquad \alpha = \|\phi\|
$$
当 $\alpha \to 0$ 时采用泰勒级数近似（向量部分趋于 $\phi/2$）。

---

## 三、状态传播与噪声离散化

1. **【保留】连续模型**：陀螺模型 $\omega_m = \omega + b_g + n_g$，零偏随机游走 $\dot{b}_g = n_{bg}$。连续名义状态传播与一阶右乘误差模型：
$$
\dot{\bar{q}} = \frac{1}{2}\bar{q} \otimes [0,\; \omega_m - \bar{b}_g], \qquad \dot{\bar{b}}_g = 0
$$
$$
\delta\dot{x} = F_c \delta x + G_c n, \qquad
F_c = \begin{bmatrix} -[\hat{\omega}]_\times & -I_3 \\ 0 & 0 \end{bmatrix}, \qquad
G_c = \begin{bmatrix} -I_3 & 0 \\ 0 & I_3 \end{bmatrix}, \qquad
\hat{\omega} = \omega_m - \bar{b}_g
$$
连续噪声功率谱密度 $Q_c = \operatorname{diag}(S_g, S_{bg}) \in \mathbb{R}^{6\times 6}$（由两个 $3\times 3$ 块 $S_g, S_{bg}$ 构成的分块对角阵，**不是** $3\times 3$ 矩阵，也不是离散每帧方差）。

2. **【保留】真实时间间隔离散传播**：使用当前帧与上一帧的真实有效时间间隔 $\Delta t_k = t_k - t_{k-1} > 0$（禁止固定为 0.5 s 或假定同步）：
$$
\bar{q}_k^- = \operatorname{normalize}\!\left(\bar{q}_{k-1}^+ \otimes \operatorname{Exp}_q(\hat{\omega}\Delta t_k)\right), \qquad
\bar{b}_{g,k}^- = \bar{b}_{g,k-1}^+
$$
$$
\Phi_k = \exp(F_c \Delta t_k), \qquad
Q_{d,k} = \int_0^{\Delta t_k} \exp(F_c \tau) G_c Q_c G_c^T \exp(F_c^T \tau)\,d\tau
$$
$$
P_k^- = \Phi_k P_{k-1}^+ \Phi_k^T + Q_{d,k}
$$
不得将 $Q_c$ 直接当作 $Q_{d,k}$；若因算力采用一阶近似，须单列近似误差与最大允许 $\Delta t$ 且标准版与鲁棒版同步采用。

---

## 四、三维比力观测模型与雅可比（$m=3$）

1. **【修订 6X-M02】比力观测方程**：在 $a_s^n \approx 0$ 基础假设下：
$$
z_k = f_{m,k}^b \in \mathbb{R}^3, \qquad
h(q) = -R(q)^T g^n \in \mathbb{R}^3, \qquad
R_z = R_a \in \mathbb{R}^{3\times 3}
$$
静止且机体系 $b$ 与导航系 $n$ 重合时，$h(I) = [0, 0, +g_0]^T$（用于验证重力符号方向；严禁对向量作归一化以免破坏噪声统计与秩结构）。

2. **观测雅可比**：在名义姿态 $\bar{q}$ 处对右乘误差 $\delta x = [\delta\theta^T, \delta b_g^T]^T$ 求偏导：
$$
H_0 = \left.\frac{\partial h(\bar{q} \otimes \operatorname{Exp}_q(\delta\theta))}{\partial \delta x}\right|_0
= \begin{bmatrix} [h(\bar{q})]_\times & 0_{3\times 3} \end{bmatrix} \in \mathbb{R}^{3\times 6}
$$

---

## 五、无磁初始化、Yaw 约定与可观性限制

1. **【修订 6X-M03】【新增 6X-N01】无磁倾斜初始化**：
   - 在静止窗口内取平均比力 $\bar{f}^b$（校验 $\|\bar{f}^b\| \approx g_0$），仅可唯一确定 Roll（$\phi_0$）与 Pitch（$\theta_0$）：
     $$
     \phi_0 = \operatorname{atan2}(\bar{f}_y^b, \bar{f}_z^b), \qquad
     \theta_0 = \operatorname{atan2}(-\bar{f}_x^b, \sqrt{(\bar{f}_y^b)^2 + (\bar{f}_z^b)^2})
     $$
   - **Yaw 零方向约定**：无磁力计时 Yaw 不可观测，初始化固定取相对零方向 $\psi_0 = 0$（或试验前登记的标定起始角），并记录参考零方向；**不得宣称输出为地理真北或绝对航向**。
2. **【新增 6X-N02】可观性与漂移限制**：
   - 在仅有三轴比力观测的六轴配置下，绕重力轴的航向误差 $\delta\theta_z$ 与对应陀螺零偏分量在静止及纯倾斜运动下不可观（绝对航向没有外部参考；一般运动下零偏可观性需另行分析，姿态耦合不等于获得绝对航向）。
   - Yaw 会随 $b_{gz}$ 残余误差与陀螺随机游走持续漂移；文档与界面须始终保持「Yaw 为相对参考且存在积分漂移」的显式提示。
   - 若初始横滚/俯仰静止窗口同时估计初始零偏 $\bar{b}_{g,0}$，必须记录初始零偏方差；不得假定三轴零偏在短时动态中全部收敛。

---

## 六、双侧白化 Huber 迭代更新（固定先验切空间）

1. **【保留】固定先验与 Cholesky 白化**：每帧更新保存唯一先验 $(\bar{q}^-, \bar{b}_g^-, P^-)$，禁止内循环重复时间预测。固定下三角 Cholesky 分解 $P^- = L_p L_p^T$、$R_a = L_r L_r^T$（正对角、通道顺序固定为第 2 节顺序）。定义总修正 $\xi = [\phi^T, \beta^T]^T \in \mathbb{R}^6$，姿态 $q(\xi) = \bar{q}^- \otimes \operatorname{Exp}_q(\phi)$，零偏 $b(\xi) = \bar{b}_g^- + \beta$。
   $$
   e_x(\xi) = L_p^{-1}\xi \in \mathbb{R}^6, \qquad
   e_y(\xi) = L_r^{-1}\big[z_k - h(q(\xi))\big] \in \mathbb{R}^3
   $$
2. **【保留】Huber 损失、完整鲁棒目标与非平方权重**：
   $$
   \rho_\mu(e) = \begin{cases} \tfrac{1}{2}e^2, & |e| \le \mu \\ \mu|e| - \tfrac{1}{2}\mu^2, & |e| > \mu \end{cases}, \qquad
   w_\mu(e) = \begin{cases} 1, & |e| \le \mu \\ \mu / |e|, & |e| > \mu \end{cases}
   $$
   $e = 0$ 时按连续极限取 $w = 1$；**禁止**用 $(\mu/|e|)^2$ 替代。完整双侧白化鲁棒目标函数为：
   $$
   J(\xi) = \sum_{i=1}^{6} \rho_{\mu_x}(e_{x,i}(\xi)) + \sum_{j=1}^{3} \rho_{\mu_y}(e_{y,j}(\xi))
   $$
   状态侧与观测侧权重矩阵 $W_x = \operatorname{diag}(w_{\mu_x}(e_{x,i})) \in \mathbb{R}^{6\times 6}$、$W_y = \operatorname{diag}(w_{\mu_y}(e_{y,j})) \in \mathbb{R}^{3\times 3}$，对应调权协方差 $\widetilde{P} = L_p W_x^{-1} L_p^T$、$\widetilde{R} = L_r W_y^{-1} L_r^T$。
3. **【保留】固定先验 IRLS 求解（含 $\xi$ 初始化、更新、右雅可比与 Armijo 判据）**：
   - 初始化 $\xi_0 = 0_{6\times 1}$。第 $i$ 次迭代使用 $SO(3)$ 右雅可比 $J_r(\phi_i)$：
   $$
   J_r(\phi) = I_3 - \frac{1-\cos\alpha}{\alpha^2}[\phi]_\times + \frac{\alpha-\sin\alpha}{\alpha^3}[\phi]_\times^2, \qquad \alpha = \|\phi\|
   $$
   当 $\alpha \to 0$ 时使用小角度级数 $J_r(\phi) \approx I_3 - \frac{1}{2}[\phi]_\times + \frac{1}{6}[\phi]_\times^2$。
   $$
   H_i = \begin{bmatrix} [h(q_i)]_\times J_r(\phi_i) & 0_{3\times 3} \end{bmatrix}, \qquad
   A_i = L_p^{-T} W_{x,i} L_p^{-1}, \qquad
   B_i = L_r^{-T} W_{y,i} L_r^{-1}, \qquad
   r_i = z_k - h(q_i)
   $$
   求解正定方程 $(A_i + H_i^T B_i H_i)\eta_i = H_i^T B_i r_i - A_i \xi_i$（法方程用 Cholesky 求解；当前代码另通过三角求解构造白化逆因子，尚未实施循环不变量优化），并按 $\xi_{i+1} = \xi_i + s_i \eta_i$ 更新：
   - **步长控制与 Armijo 判据**：若 $\|\eta_\theta\| > 0.1\,\text{rad}$，先将初始 $s$ 限制为 $0.1 / \|\eta_\theta\|$；从该初始 $s$（或 $s=1$）开始最多回溯 12 次（每次减半），满足 Armijo 充分下降条件
     $$
     J(\xi_i + s\eta_i) \le J(\xi_i) + c_1 s\,\nabla J(\xi_i)^T \eta_i, \qquad c_1 = 10^{-4}
     $$
     后接受（其中 $\nabla J(\xi_i) = A_i \xi_i - H_i^T B_i r_i$）。
   - **停止条件（建议数值配置）**：$\|\Delta\phi\| < 10^{-7}\,\text{rad}$、$\|\Delta\beta\| < 10^{-8}\,\text{rad/s}$ 且相对目标变化 $\le 10^{-6}$；最大迭代 15 次。
   - **失败恢复**：若不收敛、Cholesky 失败、出现非有限值、回溯失败或总姿态修正 $\|\phi\| > 30^\circ$（局部有效域），按目标规格应**放弃本帧观测更新**，恢复先验 $(\bar{q}^-, \bar{b}_g^-, P^-)$ 并记录具体失败原因，禁止静默接受最后一步。
4. **【保留】误差注入与协方差坐标重置**：收敛后 $\xi^* = [\phi^{*T}, \beta^{*T}]^T$：
   $$
   \bar{q}^+ = \operatorname{normalize}(\bar{q}^- \otimes \operatorname{Exp}_q(\phi^*)), \qquad
   \bar{b}_g^+ = \bar{b}_g^- + \beta^*
   $$
   $$
   C_\xi = (A_* + H_*^T B_* H_*)^{-1}, \qquad
   T = \operatorname{diag}(J_r(\phi^*), I_3), \qquad
   P^+ = T C_\xi T^T
   $$
   明确说明 $C_\xi$ 是固定最终权重下的局部加权曲率近似，**不冒充真实非线性后验误差协方差**。

---

## 七、目标对照矩阵与当前运行状态（勿将规划当作实现）

1. **【修订 6X-M04】状态命名**：在六轴主配置中，「无磁力计」是正常常态，不得将所有正常帧标为「磁力计故障」。状态枚举定义为：
   - `SIX_AXIS_NOMINAL`（六轴倾斜更新正常，Yaw 相对零方向传播）
   - `PROPAGATE_ONLY_DYNAMIC_ACC`（当前用于数值求解/局部域等失败恢复后的仅传播；尚无独立动态比力物理门控，不应由名称认定检测到了动态加速）
   - `DEGRADED_GYRO_GAP`（目标规格中的待实现状态；当前类型和主循环未提供此枚举，不声称缺口会自动停止传播）
2. **【保留】目标消融矩阵**：以下为研究规划。当前仅 A0/A4 已实现，A1/A2/A3 暂缓；未来增加时须同输入、同初始化、同 $Q_c / R_a / P_0$ 对比：
   - **A0**：一次线性化标准 ESKF（Joseph 形式更新，固定权重 1）
   - **A1**：迭代二次损失 ESKF（与 IRLS 相同线性化/步长/停止条件，权重固定 1，用于分离「迭代收益」与「Huber 调权收益」）
   - **A2**：仅观测侧 Huber（$W_x = I_6$）
   - **A3**：仅状态侧 Huber（$W_y = I_3$）
   - **A4**：双侧白化 Huber（本方案主链路）

---

## 八、参数来源、标定与验证矩阵（严格区分待测与已验证）

> [!WARNING]
> **禁止参数挪用**：当前演示工作台角度 KF 使用的 `q=40.0 deg²/s³`、`R=2.25 deg²`、`P0=diag(4,100)` **仅用于角度标量演示**，严禁作为真实六轴 IMU 的连续噪声谱密度或观测协方差。

| 参数 / 指标 | 类别 | 当前状态 | 说明 |
| :--- | :--- | :--- | :--- |
| $S_g$ (`rad²/s`), $S_{bg}$ (`rad²/s³`) | 硬件标定参数 | **待实测标定** | 须由静止 Allan 方差或厂商核实数据计算并冻结 |
| $R_a$ (`(m/s²)²`) | 硬件标定参数 | **待实测标定** | 须由静止比力方差统计 |
| $P_0$ | 初始不确定度 | **待初始化确认** | 需区分静止倾斜对齐精度与初始零偏不确定度 |
| $\mu_x, \mu_y$ | 鲁棒阈值 | **建议预注册选值** | 如 $\mu_x = \mu_y \in [1.5, 3.0]$，实验前冻结，不得按结果反复调参 |
| 求解器阈值 (`0.1 rad`, `15 次`, `30°`) | 数值求解配置 | **新增建议阈值** | 需经边界单测后冻结 |
| 真实姿态精度 / 恢复时间 / RMSE | 验收结果 | **尚无实测结果** | 已有真实日志可供处理，但仍缺独立参考与系统验收；无独立真值时仅能报告相对偏差 |

**分层验证矩阵（待系统性实测验收，不是完成清单）**：
- **正常工况**：静止对齐、单轴转动（Roll/Pitch/Yaw）、多轴组合转动。
- **异常与边界工况**：单帧比力尖峰、窗口持续偏置、慢漂移、快速剧烈转动、强动态平动比力、串口丢包／时间跳变／时钟漂移、陀螺饱和或故障。
- **定量验证指标与重复实验要求**：
  - 指标：姿态旋转误差 $\text{RMSE}$、峰值误差 $\max|\Delta\theta|$、异常注入后的恢复时间 $T_{\text{rec}}$、稳态误差、归一化创新一致性（NIS / NEES）。
  - 重复实验：每组故障注入／Monte Carlo 实验至少重复 $N \ge 5$ 次独立采样或固定随机种子对照，同时报告均值与最坏值，开发集与验收测试集严格分离。
  - 参考评价要求：仅可使用独立标定的外部参考评价绝对误差；参考未知或与被测同源时，只报告相对日志偏差。


## 九、代码实现核对表（2026-11-20）

| 项目 | 实际实现与边界 |
|---|---|
| 输入/状态 | 原始三轴角速度 rad/s、比力 m/s²；四元数+三轴零偏，6维局部误差；无磁 |
| 传播 | 使用有效时间差；闭式旋转/耦合块及4点高斯-勒让德 Qd 积分；不是对任意连续运动的无误差精确积分 |
| 初始化 | 使用相对时间 <=0.5s 且最多50帧的比力均值计算倾斜，Yaw零起点，初始零偏为0。没有自动静止检测、静止窗零偏标定及完整初始化质量门禁 |
| A0 | 单次线性化、Joseph更新和误差协方差坐标重置 |
| A4 | 固定先验、双侧白化、Huber非平方权重、IRLS/Armijo、局部姿态修正保护 |
| 暂用默认值 | sg=1e-4 rad²/s；sbg=1e-7 rad²/s³；ra=0.04 (m/s²)²；p0Theta=0.02 rad²；p0Bg=1e-4 (rad/s)²；muX=muY=2。不是传感器已标定结果 |
| 诊断 | 输出姿态、零偏、wyMean/wxMean、白化残差范数、迭代数、运行状态；均值权重不是每轴独立观测权重 |
| 求解限制 | 最多15次；提前停止另有1e-9/1e-10小步判据。耗尽迭代预算并未单列“不收敛”失败状态，不能声称完全兑现第六节严格失败规格 |
| 终点诊断 | 权重/曲率使用迭代中保存的量；终点重算一致性、曲率与真实后验等价性未单独证明 |
| 降级 | 当前仅SIX_AXIS_NOMINAL、PROPAGATE_ONLY_DYNAMIC_ACC；未逐项导出详细失败原因；仅传播帧的权重默认1不代表接受观测 |
| 尚待工作 | A1–A3、物理质量层、自动标定、求解性能优化、系统性边界与独立真值实验，均未因文档更新而实现 |

## 十、界面比较口径

- 六轴分析、三维回放、位置角演示共享成功导入的六轴记录；旧位置角KF仍是独立模型。不可把其输出当成本六轴算法。
- 软件脉冲仅改变输入副本，标准与鲁棒接收相同分支；九宫格偏差为“同算法当前输出减未注入输出”，不是独立真值误差。原 CSV 姿态和控制指令也不是真值。
- PR #5 指令叠加使用可调时间偏移、重叠区间插值及可选起点姿态对齐；跟随RMSE是相对指令的差异，既不能替代硬件同步，也不能证明滤波精度。
- 单元测试和页面展示仅覆盖部分实现行为；原 PDF→补充方案→代码的逐公式核查仍未完成。当前不得发布“完全忠实原文且精度已证实”的结论。
