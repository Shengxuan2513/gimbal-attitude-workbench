# 六轴鲁棒姿态估计算法主方案（无磁力计 ESKF + 双侧白化 Huber）

版本：六轴主方案 1.0　日期：2026 年 11 月 19 日

> [!IMPORTANT]
> **当前实现边界声明**：本文档是面向 WT61PC（无磁力计）六轴原始 IMU 的完整算法规格，保留原方案及《补充审阅稿 1.0》的核心数学结构。**当前工作台尚未接入本完整六轴 ESKF**，工作台目前仅运行用于界面演示的简化角度 KF／Huber KF 与位置角回放；不得将简化角度 KF 冒充本方案的完整实现，也不得将现有 50 帧位置／转速／角加速度 Excel 当作六轴原始 IMU 输入。

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
连续噪声功率谱密度 $Q_c = \operatorname{diag}(S_g, S_{bg})$（$3\times 3$ 对角阵，**不是**离散每帧方差）。

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
   - 在仅有三轴比力观测的六轴配置下，绕重力轴的航向误差 $\delta\theta_z$ 与对应陀螺零偏分量在静止及纯倾斜运动下不可观（仅靠过程传播与非零横滚/俯仰耦合提供有限可观性）。
   - Yaw 会随 $b_{gz}$ 残余误差与陀螺随机游走持续漂移；文档与界面须始终保持「Yaw 为相对参考且存在积分漂移」的显式提示。
   - 若初始横滚/俯仰静止窗口同时估计初始零偏 $\bar{b}_{g,0}$，必须记录初始零偏方差；不得假定三轴零偏在短时动态中全部收敛。

---

## 六、双侧白化 Huber 迭代更新（固定先验切空间）

1. **【保留】固定先验与 Cholesky 白化**：每帧更新保存唯一先验 $(\bar{q}^-, \bar{b}_g^-, P^-)$，禁止内循环重复时间预测。固定下三角 Cholesky 分解 $P^- = L_p L_p^T$、$R_a = L_r L_r^T$（正对角、通道顺序固定为第 2 节顺序）。定义总修正 $\xi = [\phi^T, \beta^T]^T \in \mathbb{R}^6$，姿态 $q(\xi) = \bar{q}^- \otimes \operatorname{Exp}_q(\phi)$，零偏 $b(\xi) = \bar{b}_g^- + \beta$。
   $$
   e_x(\xi) = L_p^{-1}\xi \in \mathbb{R}^6, \qquad
   e_y(\xi) = L_r^{-1}\big[z_k - h(q(\xi))\big] \in \mathbb{R}^3
   $$
2. **【保留】Huber 损失与非平方权重**：
   $$
   \rho_\mu(e) = \begin{cases} \tfrac{1}{2}e^2, & |e| \le \mu \\ \mu|e| - \tfrac{1}{2}\mu^2, & |e| > \mu \end{cases}, \qquad
   w_\mu(e) = \begin{cases} 1, & |e| \le \mu \\ \mu / |e|, & |e| > \mu \end{cases}
   $$
   $e = 0$ 时按连续极限取 $w = 1$；**禁止**用 $(\mu/|e|)^2$ 替代。状态侧与观测侧权重矩阵 $W_x = \operatorname{diag}(w_{\mu_x}(e_{x,i}))$、$W_y = \operatorname{diag}(w_{\mu_y}(e_{y,j}))$，对应调权协方差 $\widetilde{P} = L_p W_x^{-1} L_p^T$、$\widetilde{R} = L_r W_y^{-1} L_r^T$。
3. **【保留】固定先验 IRLS 求解**：第 $i$ 次迭代使用 $SO(3)$ 右雅可比 $J_r(\phi_i)$：
   $$
   H_i = \begin{bmatrix} [h(q_i)]_\times J_r(\phi_i) & 0_{3\times 3} \end{bmatrix}, \qquad
   A_i = L_p^{-T} W_{x,i} L_p^{-1}, \qquad
   B_i = L_r^{-T} W_{y,i} L_r^{-1}, \qquad
   r_i = z_k - h(q_i)
   $$
   求解正定方程 $(A_i + H_i^T B_i H_i)\eta_i = H_i^T B_i r_i - A_i \xi_i$（用 Cholesky 分解求解，禁止显式求逆），并按以下求解器控制与失败恢复规则执行：
   - **步长控制**：若 $\|\eta_\theta\| > 0.1\,\text{rad}$，先缩放到 $0.1 / \|\eta_\theta\|$；从 $s = 1$ 开始最多 Armijo 回溯 12 次（每次减半，$c_1 = 10^{-4}$）。
   - **停止条件（建议数值配置）**：$\|\Delta\phi\| < 10^{-7}\,\text{rad}$、$\|\Delta\beta\| < 10^{-8}\,\text{rad/s}$ 且相对目标变化 $\le 10^{-6}$；最大迭代 15 次。
   - **失败恢复**：若不收敛、Cholesky 失败、出现非有限值、回溯失败或总姿态修正 $\|\phi\| > 30^\circ$（局部有效域），**放弃本帧观测更新**，恢复先验 $(\bar{q}^-, \bar{b}_g^-, P^-)$ 并记录具体失败原因，禁止静默接受最后一步。
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

## 七、六轴运行状态命名与标准对照

1. **【修订 6X-M04】状态命名**：在六轴主配置中，「无磁力计」是正常常态，不得将所有正常帧标为「磁力计故障」。状态枚举定义为：
   - `SIX_AXIS_NOMINAL`（六轴倾斜更新正常，Yaw 相对零方向传播）
   - `PROPAGATE_ONLY_DYNAMIC_ACC`（动态比力超限或失败恢复后仅陀螺传播）
   - `DEGRADED_GYRO_GAP`（陀螺无效或时间缺口超限，停止外推）
2. **【保留】公平对照链路**：必须同输入、同初始化、同 $Q_c / R_a / P_0$ 运行以下对照：
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
| 真实姿态精度 / 恢复时间 / RMSE | 验收结果 | **尚无实测结果** | 今晚采集真实六轴日志后才可执行；无独立真值时仅能报告相对偏差 |

**分层验证矩阵（待今晚实测后执行）**：
- 正常工况：静止对齐、单轴转动（Roll/Pitch/Yaw）、多轴组合转动。
- 异常与边界工况：单帧比力尖峰、窗口持续偏置、慢漂移、快速剧烈转动、强动态平动比力、串口丢包／时间跳变／时钟漂移、陀螺饱和或故障。
- 参考评价要求：仅可使用独立标定的外部参考评价绝对误差；参考未知或与被测同源时，只报告相对日志偏差。
