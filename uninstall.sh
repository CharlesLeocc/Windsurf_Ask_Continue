#!/bin/bash
# ============================================================
# Ask Continue - Mac/Linux 卸载脚本
# ============================================================
# 功能：
#   1. 删除 MCP 配置中的 ask-continue
#   2. 删除全局规则文件（可选）
#   3. 提示用户手动卸载 VSIX 扩展
# ============================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}   Ask Continue - 卸载脚本${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""

# 检测 Python 命令
if command -v python3 &> /dev/null; then
    PYTHON_CMD="python3"
elif command -v python &> /dev/null; then
    PYTHON_CMD="python"
else
    echo -e "${RED}[错误]${NC} 未找到 Python，无法自动修改配置文件"
    echo "请手动删除以下文件中的 ask-continue 配置："
    echo "  ~/.codeium/windsurf/mcp_config.json"
    exit 1
fi

# ========== 步骤 1：移除 MCP 配置 ==========
echo -e "${YELLOW}[1/3]${NC} 移除 MCP 配置..."

WINDSURF_MCP_FILE="$HOME/.codeium/windsurf/mcp_config.json"

if [ -f "$WINDSURF_MCP_FILE" ]; then
    # 备份
    cp "$WINDSURF_MCP_FILE" "$WINDSURF_MCP_FILE.backup"
    
    # 使用 Python 删除 ask-continue 配置
    $PYTHON_CMD << EOF
import json
import sys

config_file = "$WINDSURF_MCP_FILE"

try:
    with open(config_file, 'r') as f:
        config = json.load(f)
    
    if 'mcpServers' in config and 'ask-continue' in config['mcpServers']:
        del config['mcpServers']['ask-continue']
        
        with open(config_file, 'w') as f:
            json.dump(config, f, indent=2)
        
        print("已移除 ask-continue 配置")
    else:
        print("未找到 ask-continue 配置")
except Exception as e:
    print(f"修改配置失败: {e}", file=sys.stderr)
    sys.exit(1)
EOF
    echo -e "${GREEN}[OK]${NC} MCP 配置已更新"
else
    echo -e "${YELLOW}[跳过]${NC} MCP 配置文件不存在"
fi

# ========== 步骤 2：询问是否删除全局规则 ==========
echo ""
echo -e "${YELLOW}[2/3]${NC} 处理全局规则文件..."

RULES_FILE="$HOME/.windsurfrules"

if [ -f "$RULES_FILE" ]; then
    echo -e "${BLUE}[提示]${NC} 发现全局规则文件: $RULES_FILE"
    read -p "是否删除？(y/N): " confirm
    
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
        # 备份后删除
        cp "$RULES_FILE" "$RULES_FILE.backup"
        rm "$RULES_FILE"
        echo -e "${GREEN}[OK]${NC} 全局规则已删除（备份在 $RULES_FILE.backup）"
    else
        echo -e "${YELLOW}[跳过]${NC} 保留全局规则文件"
    fi
else
    echo -e "${YELLOW}[跳过]${NC} 全局规则文件不存在"
fi

# ========== 步骤 3：提示卸载扩展 ==========
echo ""
echo -e "${YELLOW}[3/3]${NC} 卸载 Windsurf 扩展..."
echo -e "${BLUE}[提示]${NC} 请手动卸载扩展："
echo "        1. 打开 Windsurf"
echo "        2. 按 Cmd+Shift+X 打开扩展面板"
echo "        3. 搜索 'Ask Continue'"
echo "        4. 点击卸载"

# ========== 完成 ==========
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}   卸载完成！${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "备份文件位置："
echo "  MCP 配置备份: $WINDSURF_MCP_FILE.backup"
if [ -f "$RULES_FILE.backup" ]; then
    echo "  规则文件备份: $RULES_FILE.backup"
fi
echo ""
echo "请重启 Windsurf 使更改生效。"
echo ""
