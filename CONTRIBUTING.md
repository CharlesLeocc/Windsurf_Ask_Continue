# 贡献指南

感谢你对 Windsurf 对话增强工具的关注！欢迎任何形式的贡献。

---

## 📋 如何贡献

### 报告 Bug

1. 先搜索 [Issues](https://github.com/1837620622/Windsurf_Ask_Continue/issues) 确认问题未被报告
2. 创建新 Issue，包含以下信息：
   - 问题描述
   - 复现步骤
   - 期望行为
   - 实际行为
   - 系统环境（Windows/Mac、Windsurf 版本、Python 版本）
   - 相关日志或截图

### 提交功能建议

1. 创建 Issue 描述你的想法
2. 说明这个功能解决什么问题
3. 如果可能，提供实现思路

### 提交代码

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feature/你的功能名`
3. 提交更改：`git commit -m 'feat: 添加某功能'`
4. 推送分支：`git push origin feature/你的功能名`
5. 创建 Pull Request

---

## 🛠️ 开发环境

### 前置要求

- Node.js 18+
- Python 3.10+
- Windsurf IDE

### 本地开发

```bash
# 克隆仓库
git clone https://github.com/1837620622/Windsurf_Ask_Continue.git
cd Windsurf_Ask_Continue

# 安装 Node.js 依赖
npm install

# 安装 Python 依赖
cd mcp-server-python
pip install -r requirements.txt
cd ..

# 编译 TypeScript
npm run compile

# 打包 VSIX（可选）
npm run package
```

### 项目结构

```
├── extension.ts         # Windsurf 扩展主入口
├── mcp-server-python/   # MCP Server（Python）
│   └── server.py        # 主程序
├── dist/                # 编译输出
└── package.json         # 项目配置
```

---

## 📝 代码规范

### Commit 消息格式

使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 规范：

- `feat:` 新功能
- `fix:` Bug 修复
- `docs:` 文档更新
- `style:` 代码格式（不影响功能）
- `refactor:` 重构
- `test:` 测试相关
- `chore:` 构建/工具相关

示例：
```
feat: 添加历史记录功能
fix: 修复 Mac 端口检测问题
docs: 更新 README 安装说明
```

### 代码风格

- TypeScript：使用项目配置的 ESLint 规则
- Python：遵循 PEP 8
- 注释使用中文，变量/函数名使用英文

---

## 📄 许可证

提交贡献即表示你同意将代码以 [CC BY-NC-SA 4.0](./LICENSE) 许可证发布。

---

## 💬 联系方式

- GitHub Issues：[提问/反馈](https://github.com/1837620622/Windsurf_Ask_Continue/issues)
- 微信：1837620622（传康kk）
- 邮箱：2040168455@qq.com

---

再次感谢你的贡献！⭐
