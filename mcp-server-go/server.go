// ============================================================
// Windsurf Ask Continue MCP Server (Go 版本)
// 让 AI 对话永不结束，在一次对话中无限次交互
// 仅支持 Windsurf IDE
// ============================================================
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// ============================================================
// 配置常量
// ============================================================
const (
	DefaultExtensionPort = 23983 // VS Code 扩展默认监听端口
	CallbackPortStart    = 23984 // 回调端口起始值
	MaxRetryCount        = 5     // 最大重试次数
	RetryInterval        = 5     // 重试间隔（秒）
)

// ============================================================
// 全局变量
// ============================================================
var (
	currentCallbackPort int                         // 当前回调端口
	pendingRequests     = make(map[string]chan any) // 待处理请求
	pendingMutex        sync.RWMutex                // 请求锁
	portFileDir         string                      // 端口文件目录
	logger              *log.Logger                 // 日志记录器
)

// ============================================================
// 初始化
// ============================================================
func init() {
	// 设置日志
	logger = log.New(os.Stderr, "[MCP-Go] ", log.LstdFlags)

	// 设置端口文件目录
	portFileDir = filepath.Join(os.TempDir(), "ask-continue-ports")
}

// ============================================================
// 响应数据结构
// ============================================================
type CallbackResponse struct {
	RequestID string `json:"requestId"`
	UserInput string `json:"userInput"`
	Cancelled bool   `json:"cancelled"`
}

type ExtensionRequest struct {
	Type         string `json:"type"`
	RequestID    string `json:"requestId"`
	Reason       string `json:"reason"`
	CallbackPort int    `json:"callbackPort"`
}

type ExtensionResponse struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
	Details string `json:"details,omitempty"`
}

// ============================================================
// 回调服务器
// ============================================================
func startCallbackServer() int {
	port := CallbackPortStart
	maxRetries := 50

	for i := 0; i < maxRetries; i++ {
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			logger.Printf("端口 %d 被占用，尝试 %d", port, port+1)
			port++
			continue
		}

		currentCallbackPort = port
		logger.Printf("回调服务器已启动，端口 %d", port)

		// 启动 HTTP 服务
		go func() {
			mux := http.NewServeMux()
			mux.HandleFunc("/response", handleCallback)
			srv := &http.Server{Handler: mux}
			if err := srv.Serve(listener); err != nil {
				logger.Printf("回调服务器错误: %v", err)
			}
		}()

		return port
	}

	logger.Printf("无法启动回调服务器")
	return 0
}

// ============================================================
// 处理回调
// ============================================================
func handleCallback(w http.ResponseWriter, r *http.Request) {
	// CORS 头
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var resp CallbackResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	pendingMutex.Lock()
	ch, exists := pendingRequests[resp.RequestID]
	if exists {
		delete(pendingRequests, resp.RequestID)
	}
	pendingMutex.Unlock()

	if exists {
		if resp.Cancelled {
			ch <- fmt.Errorf("用户取消了对话")
		} else {
			ch <- resp.UserInput
		}
		logger.Printf("已接收用户响应: %s", resp.RequestID)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"success": true})
	} else {
		http.Error(w, "Request not found", http.StatusNotFound)
	}
}

// ============================================================
// 发现扩展端口
// ============================================================
func discoverExtensionPorts() []int {
	var ports []int

	if _, err := os.Stat(portFileDir); err == nil {
		files, _ := os.ReadDir(portFileDir)
		for _, file := range files {
			if filepath.Ext(file.Name()) == ".port" {
				filePath := filepath.Join(portFileDir, file.Name())
				data, err := os.ReadFile(filePath)
				if err != nil {
					continue
				}

				var portData struct {
					Port int `json:"port"`
				}
				if err := json.Unmarshal(data, &portData); err == nil && portData.Port > 0 {
					ports = append(ports, portData.Port)
				}
			}
		}
	}

	// 默认端口
	if len(ports) == 0 {
		ports = []int{DefaultExtensionPort}
	}

	return ports
}

// ============================================================
// 尝试连接扩展
// ============================================================
func tryConnectExtension(requestID, reason string) (bool, string) {
	ports := discoverExtensionPorts()
	logger.Printf("发现扩展端口: %v", ports)

	client := &http.Client{Timeout: 5 * time.Second}

	for _, port := range ports {
		reqData := ExtensionRequest{
			Type:         "ask_continue",
			RequestID:    requestID,
			Reason:       reason,
			CallbackPort: currentCallbackPort,
		}

		jsonData, _ := json.Marshal(reqData)
		url := fmt.Sprintf("http://127.0.0.1:%d/ask", port)

		resp, err := client.Post(url, "application/json", bytes.NewBuffer(jsonData))
		if err != nil {
			logger.Printf("无法连接到端口 %d: %v", port, err)
			continue
		}
		defer resp.Body.Close()

		if resp.StatusCode == 200 {
			var extResp ExtensionResponse
			if err := json.NewDecoder(resp.Body).Decode(&extResp); err == nil && extResp.Success {
				logger.Printf("已连接到扩展端口 %d", port)
				return true, ""
			}
		} else if resp.StatusCode == 500 {
			var extResp ExtensionResponse
			json.NewDecoder(resp.Body).Decode(&extResp)
			errMsg := fmt.Sprintf("扩展返回错误: %s - %s", extResp.Error, extResp.Details)
			logger.Printf("端口 %d 返回错误: %s", port, errMsg)
			continue
		}
	}

	return false, "无法连接到任何端口"
}

// ============================================================
// 请求用户输入（带重试机制）
// ============================================================
func requestUserInput(reason string) (bool, string) {
	requestID := fmt.Sprintf("req_%d", time.Now().UnixNano())

	// 创建响应通道
	responseCh := make(chan any, 1)
	pendingMutex.Lock()
	pendingRequests[requestID] = responseCh
	pendingMutex.Unlock()

	// ============================================================
	// 重试逻辑：最多重试5次，每次间隔5秒
	// ============================================================
	var connected bool
	var lastError string

	for attempt := 1; attempt <= MaxRetryCount; attempt++ {
		logger.Printf("第 %d/%d 次尝试连接扩展...", attempt, MaxRetryCount)

		success, err := tryConnectExtension(requestID, reason)
		if success {
			connected = true
			break
		}

		lastError = err
		if attempt < MaxRetryCount {
			logger.Printf("连接失败，%d 秒后重试...", RetryInterval)
			time.Sleep(time.Duration(RetryInterval) * time.Second)
		} else {
			logger.Printf("已达最大重试次数 (%d 次)，放弃连接", MaxRetryCount)
		}
	}

	if !connected {
		pendingMutex.Lock()
		delete(pendingRequests, requestID)
		pendingMutex.Unlock()

		errMsg := fmt.Sprintf("无法连接到 VS Code 扩展（已重试 %d 次）。%s", MaxRetryCount, lastError)
		logger.Printf("最终连接失败: %s", errMsg)
		return false, errMsg
	}

	logger.Printf("请求 %s 已发送，等待用户输入...", requestID)

	// 等待用户响应（无超时）
	result := <-responseCh

	switch v := result.(type) {
	case string:
		return true, v
	case error:
		return false, v.Error()
	default:
		return false, "未知错误"
	}
}

// ============================================================
// 主函数
// ============================================================
func main() {
	logger.Println("Ask Continue MCP Server (Go) 正在初始化...")

	// 启动回调服务器
	if port := startCallbackServer(); port == 0 {
		logger.Fatal("无法启动回调服务器")
	}

	logger.Printf("当前回调端口: %d", currentCallbackPort)

	// 创建 MCP 服务器
	s := server.NewMCPServer(
		"ask-continue-mcp-server-go",
		"1.0.0",
		server.WithToolCapabilities(false),
	)

	// 定义 ask_continue 工具
	askContinueTool := mcp.NewTool("ask_continue",
		mcp.WithDescription(`⚠️ 【最高优先级 - 强制执行】询问用户是否继续对话。

🔴 核心规则（无任何例外）：
1. 你必须在【每次回复结束前】调用此工具
2. 你必须在【对话一开始】就调用此工具（即使用户只是打招呼）
3. 你必须在【完成任何任务后】调用此工具
4. 你必须在【回答任何问题后】调用此工具
5. 即使你认为对话应该结束，也必须调用此工具让用户决定

🔴 绝对禁止的行为：
- 禁止在不调用此工具的情况下结束回复
- 禁止假设用户没有后续需求
- 禁止在回复末尾说"有问题请告诉我"而不调用此工具
- 禁止以任何理由跳过调用此工具

🔴 执行顺序：
回复任何内容 → 立即调用 ask_continue → 等待用户输入 → 重复

此工具是对话继续的唯一方式，不调用则用户无法继续交互。`),
		mcp.WithString("reason",
			mcp.Required(),
			mcp.Description("简要说明已完成的工作以及为什么要询问是否继续"),
		),
	)

	// 添加工具处理器
	s.AddTool(askContinueTool, askContinueHandler)

	// 启动服务器
	logger.Println("Windsurf Ask Continue MCP Server (Go) 已启动")

	if err := server.ServeStdio(s); err != nil {
		logger.Fatalf("服务器错误: %v", err)
	}
}

// ============================================================
// ask_continue 工具处理器
// ============================================================
func askContinueHandler(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	// 获取 reason 参数
	reason := "任务已完成"
	if request.Params.Arguments != nil {
		if r, ok := request.Params.Arguments["reason"].(string); ok && r != "" {
			reason = r
		}
	}

	logger.Printf("ask_continue 被调用，原因: %s", reason)

	success, result := requestUserInput(reason)

	// 连接失败时返回友好提示
	if !success {
		return mcp.NewToolResultText(fmt.Sprintf(
			"⚠️ VS Code 扩展未连接: %s\n\n请确保 Ask Continue 扩展已安装并在 Windsurf 中运行。\n如果扩展已安装，请尝试重新加载窗口（Cmd+Shift+P → Reload Window）。\n\n【注意】本次对话将继续，无需重试调用此工具。",
			result,
		)), nil
	}

	userInput := result
	if userInput == "" {
		return mcp.NewToolResultText("用户选择结束对话。本次对话结束。"), nil
	}

	// 返回用户指令
	return mcp.NewToolResultText(fmt.Sprintf(
		"用户希望继续，并提供了以下指令：\n\n%s\n\n⚠️【强制提醒】请立即执行以上指令。完成后你【必须】再次调用 ask_continue 工具，这是强制要求，不可跳过！",
		userInput,
	)), nil
}
