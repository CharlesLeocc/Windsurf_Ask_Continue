import * as vscode from "vscode";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";

const MCP_CALLBACK_PORT = 23984; // Port where MCP server listens for responses
const PORT_FILE_DIR = path.join(os.tmpdir(), "ask-continue-ports");

interface AskRequest {
  type: string;
  requestId: string;
  reason: string;
  callbackPort?: number;  // MCP 服务器的回调端口
}

let server: http.Server | null = null;
let statusBarItem: vscode.StatusBarItem;
let statusViewProvider: StatusViewProvider;
let lastPendingRequest: AskRequest | null = null; // 保存最近的待处理请求
let lastPendingRequestTime: number = 0; // 请求时间戳，用于判断请求是否过期

/**
 * 侧边栏状态视图
 */
class StatusViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "askContinue.statusView";
  private _view?: vscode.WebviewView;
  private _serverRunning = false;
  private _port = 23983;
  private _requestCount = 0;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlContent();

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case "restart":
          vscode.commands.executeCommand("askContinue.restart");
          break;
        case "showStatus":
          vscode.commands.executeCommand("askContinue.showStatus");
          break;
        case "openPanel":
          vscode.commands.executeCommand("askContinue.openPanel");
          break;
      }
    });
  }

  public updateStatus(running: boolean, port: number) {
    this._serverRunning = running;
    this._port = port;
    if (this._view) {
      this._view.webview.html = this._getHtmlContent();
    }
  }

  public incrementRequestCount() {
    this._requestCount++;
    if (this._view) {
      this._view.webview.html = this._getHtmlContent();
    }
  }

  private _getHtmlContent(): string {
    const statusIcon = this._serverRunning ? "🟢" : "🔴";
    const statusText = this._serverRunning ? "运行中" : "已停止";
    const statusClass = this._serverRunning ? "running" : "stopped";

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 15px;
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
    }
    .title {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .status-card {
      background: var(--vscode-editor-background);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 12px;
    }
    .status-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .status-row:last-child {
      margin-bottom: 0;
    }
    .label {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .value {
      font-size: 13px;
      font-weight: 500;
    }
    .value.running {
      color: #4ec9b0;
    }
    .value.stopped {
      color: #f14c4c;
    }
    .btn {
      width: 100%;
      padding: 8px 12px;
      margin-top: 8px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    .btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .info-box {
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textLink-foreground);
      padding: 10px;
      margin-top: 12px;
      font-size: 11px;
      line-height: 1.5;
      color: var(--vscode-descriptionForeground);
    }
    .info-box strong {
      color: var(--vscode-foreground);
    }
  </style>
</head>
<body>
  <div class="title">
    💬 Ask Continue
  </div>
  
  <div class="status-card">
    <div class="status-row">
      <span class="label">服务状态</span>
      <span class="value ${statusClass}">${statusIcon} ${statusText}</span>
    </div>
    <div class="status-row">
      <span class="label">监听端口</span>
      <span class="value">${this._port}</span>
    </div>
    <div class="status-row">
      <span class="label">对话次数</span>
      <span class="value">${this._requestCount}</span>
    </div>
  </div>
  
  <button class="btn btn-primary" onclick="openPanel()">📋 重新打开对话弹窗</button>
  <button class="btn" onclick="restart()">🔄 重启服务</button>
  
  <div class="info-box">
    <strong>提示:</strong> 如果不小心关闭了对话弹窗，点击上方按钮重新打开。
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    function openPanel() {
      vscode.postMessage({ command: 'openPanel' });
    }
    function restart() {
      vscode.postMessage({ command: 'restart' });
    }
  </script>
</body>
</html>`;
  }
}

/**
 * Send response back to MCP server
 */
async function sendResponseToMCP(
  requestId: string,
  userInput: string,
  cancelled: boolean,
  callbackPort?: number
): Promise<void> {
  const port = callbackPort || MCP_CALLBACK_PORT;
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      requestId,
      userInput,
      cancelled,
    });

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: port,
        path: "/response",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
        timeout: 5000,
      },
      (res) => {
        if (res.statusCode === 200 || res.statusCode === 404) {
          // 200 = 成功, 404 = 请求已过期/不存在（静默处理）
          resolve();
        } else {
          reject(new Error(`MCP server returned status ${res.statusCode}`));
        }
      }
    );

    req.on("error", (e) => {
      reject(new Error(`Failed to send response to MCP: ${e.message}`));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Show the Ask Continue dialog
 */
async function showAskContinueDialog(request: AskRequest): Promise<void> {
  // 保存当前请求，以便重新打开
  lastPendingRequest = request;
  lastPendingRequestTime = Date.now();
  
  let panel: vscode.WebviewPanel;
  try {
    panel = vscode.window.createWebviewPanel(
    "askContinue",
    "继续对话?",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  panel.webview.html = getWebviewContent(request.reason, request.requestId);
  } catch (err) {
    // Webview 创建失败，发送取消响应
    console.error("[Ask Continue] Failed to create webview panel:", err);
    lastPendingRequest = null;
    try {
      await sendResponseToMCP(request.requestId, "", true, request.callbackPort);
    } catch {
      // 忽略发送错误
    }
    vscode.window.showErrorMessage(`Ask Continue: 无法创建对话窗口 - ${err instanceof Error ? err.message : "未知错误"}`);
    return;
  }

  // 标记是否已发送响应，避免重复发送
  let responseSent = false;

  // Handle messages from webview
  panel.webview.onDidReceiveMessage(
    async (message) => {
      if (responseSent) return;
      
      switch (message.command) {
        case "continue":
          try {
            responseSent = true;
            lastPendingRequest = null; // 清除待处理请求
            // 如果有图片，将base64数据附加到消息后面
            let finalText = message.text;
            if (message.images && message.images.length > 0) {
              const imagesData = message.images.map((img: any, i: number) => 
                '[图片 ' + (i + 1) + ': ' + img.name + ']\n' + img.base64
              ).join('\n\n');
              finalText = finalText + '\n\n' + imagesData;
            }
            await sendResponseToMCP(request.requestId, finalText, false, request.callbackPort);
            panel.dispose();
          } catch (error) {
            responseSent = false;
            vscode.window.showErrorMessage(
              `发送响应失败: ${error instanceof Error ? error.message : "未知错误"}`
            );
          }
          break;
        case "end":
          try {
            responseSent = true;
            await sendResponseToMCP(request.requestId, "", false, request.callbackPort);
            panel.dispose();
          } catch (error) {
            responseSent = false;
            vscode.window.showErrorMessage(
              `发送响应失败: ${error instanceof Error ? error.message : "未知错误"}`
            );
          }
          break;
        case "cancel":
          try {
            responseSent = true;
            await sendResponseToMCP(request.requestId, "", true, request.callbackPort);
            panel.dispose();
          } catch (error) {
            // Ignore errors on cancel
          }
          break;
        case "readFile":
          // 处理从文件资源管理器拖拽的文件读取请求
          try {
            const filePath = message.path;
            if (filePath && fs.existsSync(filePath)) {
              const fileContent = fs.readFileSync(filePath);
              const base64 = `data:image/${path.extname(filePath).slice(1)};base64,${fileContent.toString('base64')}`;
              const fileName = path.basename(filePath);
              const fileSize = fs.statSync(filePath).size;
              panel.webview.postMessage({
                command: 'fileContent',
                type: message.type,
                base64: base64,
                name: fileName,
                size: fileSize
              });
            }
          } catch (err) {
            console.error('[Ask Continue] Failed to read file:', err);
          }
          break;
      }
    },
    undefined,
    []
  );

  // Handle panel close (treat as cancel only if no response sent yet)
  panel.onDidDispose(async () => {
    // 清除待处理请求（无论是否已发送响应）
    if (lastPendingRequest?.requestId === request.requestId) {
      lastPendingRequest = null;
    }
    if (responseSent) return;
    try {
      await sendResponseToMCP(request.requestId, "", true, request.callbackPort);
    } catch {
      // Ignore errors on dispose
    }
  });
}

/**
 * Generate webview HTML content
 */
function getWebviewContent(reason: string, requestId: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>继续对话?</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      padding: 20px;
      color: var(--vscode-foreground, #cccccc);
      background-color: var(--vscode-editor-background, #1e1e1e);
      min-height: 100vh;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 20px;
      padding-bottom: 15px;
      border-bottom: 1px solid var(--vscode-panel-border, #454545);
    }
    .header-icon {
      font-size: 24px;
    }
    .header h1 {
      font-size: 18px;
      font-weight: 600;
      color: var(--vscode-foreground, #cccccc);
    }
    .reason-box {
      background-color: var(--vscode-textBlockQuote-background, #2d2d2d);
      border-left: 3px solid var(--vscode-textLink-foreground, #3794ff);
      padding: 12px 15px;
      margin-bottom: 20px;
      border-radius: 0 4px 4px 0;
    }
    .reason-label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #888888);
      margin-bottom: 5px;
    }
    .reason-text {
      font-size: 14px;
      line-height: 1.5;
    }
    .input-section {
      margin-bottom: 20px;
    }
    .input-label {
      display: block;
      font-size: 13px;
      color: var(--vscode-foreground, #cccccc);
      margin-bottom: 8px;
    }
    .optional {
      color: var(--vscode-descriptionForeground, #888888);
      font-weight: normal;
    }
    textarea {
      width: 100%;
      min-height: 120px;
      padding: 12px;
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      font-size: 13px;
      line-height: 1.5;
      color: var(--vscode-input-foreground, #cccccc);
      background-color: var(--vscode-input-background, #3c3c3c);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      border-radius: 4px;
      resize: vertical;
      outline: none;
    }
    textarea:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    textarea::placeholder {
      color: var(--vscode-input-placeholderForeground, #888888);
    }
    .button-group {
      display: flex;
      gap: 10px;
    }
    button {
      flex: 1;
      padding: 10px 20px;
      font-size: 13px;
      font-weight: 500;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    button:hover {
      opacity: 0.9;
    }
    button:active {
      opacity: 0.8;
    }
    .btn-primary {
      background-color: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
    }
    .btn-secondary {
      background-color: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ffffff);
    }
    .shortcuts {
      margin-top: 15px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888888);
      text-align: center;
    }
    .shortcuts kbd {
      background-color: var(--vscode-keybindingLabel-background, #464646);
      border: 1px solid var(--vscode-keybindingLabel-border, #5a5a5a);
      border-radius: 3px;
      padding: 1px 5px;
      font-family: inherit;
    }
    .upload-section {
      margin-bottom: 15px;
    }
    .upload-options {
      display: flex;
      gap: 15px;
      margin-bottom: 10px;
    }
    .upload-options label {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #888888);
      cursor: pointer;
    }
    .upload-hint {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #888888);
      text-align: center;
      padding: 15px;
      border: 1px dashed var(--vscode-panel-border, #454545);
      border-radius: 4px;
      margin-bottom: 10px;
      cursor: pointer;
      transition: border-color 0.2s, background-color 0.2s;
    }
    .upload-hint:hover {
      border-color: var(--vscode-focusBorder, #007fd4);
      background-color: var(--vscode-list-hoverBackground, #2a2d2e);
    }
    .upload-hint.has-image {
      border-color: var(--vscode-textLink-foreground, #3794ff);
      padding: 10px;
    }
    .images-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 8px;
    }
    .image-item {
      position: relative;
      display: inline-block;
    }
    .image-preview {
      max-width: 120px;
      max-height: 100px;
      border-radius: 4px;
      object-fit: cover;
    }
    .remove-single {
      position: absolute;
      top: -6px;
      right: -6px;
      background: var(--vscode-errorForeground, #f14c4c);
      color: white;
      border: none;
      border-radius: 50%;
      width: 18px;
      height: 18px;
      font-size: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
    }
    .remove-single:hover {
      opacity: 0.8;
    }
    .image-info {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888888);
    }
    .file-preview {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--vscode-editor-background, #1e1e1e);
      border-radius: 4px;
      max-width: 150px;
      overflow: hidden;
    }
    .file-icon {
      font-size: 24px;
      flex-shrink: 0;
    }
    .file-name {
      font-size: 11px;
      color: var(--vscode-foreground, #cccccc);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .remove-all {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ffffff);
      border: none;
      border-radius: 3px;
      padding: 4px 8px;
      font-size: 11px;
      cursor: pointer;
      margin-top: 8px;
    }
    .remove-all:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="header-icon">🔄</span>
      <h1>继续对话?</h1>
    </div>
    
    <div class="reason-box">
      <div class="reason-label">AI想要结束对话的原因:</div>
      <div class="reason-text">${escapeHtml(reason)}</div>
    </div>
    
    <div class="input-section">
      <label class="input-label">
        如需继续，请输入新的指令 <span class="optional">(可选)</span>:
      </label>
      <textarea 
        id="userInput" 
        placeholder="输入你的下一个指令..."
        autofocus
      ></textarea>
    </div>

    <div class="upload-section">
      <div class="upload-options">
        <label>上传文件 (可选):</label>
        <label><input type="radio" name="uploadType" value="base64" checked> 文件内容</label>
        <label><input type="radio" name="uploadType" value="path"> 仅路径</label>
        <input type="file" id="fileInput" multiple style="display: none;" />
      </div>
      <div class="upload-hint" id="dropZone">
        <span id="dropText">📋 <span id="pasteKey">Ctrl</span>+V 粘贴 | 拖拽文件 | <a href="#" id="selectFiles" style="color: var(--vscode-textLink-foreground, #3794ff);">点击选择</a><br><small style="opacity: 0.7;">支持从左侧文件资源管理器直接拖拽</small></span>
        <div id="imagePreviewContainer" style="display: none;">
          <div class="images-grid" id="imagesGrid"></div>
          <div class="image-info" id="imageInfo"></div>
          <button type="button" class="remove-all" id="removeAllImages">🗑️ 清空全部</button>
        </div>
      </div>
    </div>
    
    <div class="button-group">
      <button class="btn-primary" id="continueBtn">🚀 继续执行</button>
      <button class="btn-secondary" id="endBtn">⭕ 结束对话</button>
    </div>
    
    <div class="shortcuts">
      快捷键: <kbd>Enter</kbd> = 继续 | <kbd>Shift</kbd>+<kbd>Enter</kbd> = 换行 | <kbd>Esc</kbd> = 结束
    </div>
    
    <div class="footer" style="margin-top: 20px; padding-top: 15px; border-top: 1px solid var(--vscode-panel-border, #454545); font-size: 11px; color: var(--vscode-descriptionForeground, #888888); text-align: center;">
      <div>二次开发 by <a href="https://github.com/1837620622" target="_blank" style="color: var(--vscode-textLink-foreground, #3794ff);">@1837620622</a></div>
      <div style="margin-top: 5px;">如果觉得好用，请给个 ⭐ Star</div>
    </div>
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    const textarea = document.getElementById('userInput');
    const continueBtn = document.getElementById('continueBtn');
    const endBtn = document.getElementById('endBtn');
    const dropZone = document.getElementById('dropZone');
    const dropText = document.getElementById('dropText');
    const imagePreviewContainer = document.getElementById('imagePreviewContainer');
    const imagesGrid = document.getElementById('imagesGrid');
    const imageInfo = document.getElementById('imageInfo');
    const removeAllBtn = document.getElementById('removeAllImages');
    
    // 支持多种文件的数组
    let fileList = [];
    
    // 文件选择器
    const fileInput = document.getElementById('fileInput');
    const selectFilesLink = document.getElementById('selectFiles');
    
    selectFilesLink.addEventListener('click', (e) => {
      e.preventDefault();
      fileInput.click();
    });
    
    fileInput.addEventListener('change', (e) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          handleFile(files[i]);
        }
      }
      fileInput.value = ''; // 清空以便重复选择
    });
    
    // 检测Mac系统，更新快捷键提示
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0 || navigator.userAgent.toUpperCase().indexOf('MAC') >= 0;
    if (isMac) {
      document.getElementById('pasteKey').textContent = '⌘';
    }
    
    // Focus textarea on load
    textarea.focus();
    
    // Handle keyboard shortcuts
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitContinue();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        submitEnd();
      }
    });
    
    // Handle paste event - 支持粘贴图片和文件
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      
      let hasFile = false;
      for (const item of items) {
        if (item.kind === 'file') {
          hasFile = true;
          const file = item.getAsFile();
          if (file) {
            handleFile(file);
          }
        }
      }
      if (hasFile) {
        e.preventDefault();
      }
    });
    
    // Handle drag and drop
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.style.borderColor = 'var(--vscode-focusBorder, #007fd4)';
      dropZone.style.backgroundColor = 'var(--vscode-list-hoverBackground, #2a2d2e)';
    });
    
    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      if (fileList.length === 0) {
        dropZone.style.borderColor = '';
        dropZone.style.backgroundColor = '';
      }
    });
    
    // 拖拽放下 - 支持多种文件和从文件资源管理器拖拽
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.style.borderColor = '';
      dropZone.style.backgroundColor = '';
      
      // 尝试获取 VS Code 资源管理器拖拽的文件 URI
      const uriList = e.dataTransfer?.getData('text/uri-list');
      if (uriList) {
        const uris = uriList.split('\\n').filter(uri => uri.trim() && !uri.startsWith('#'));
        for (const uri of uris) {
          handleFileUri(uri.trim());
        }
        return;
      }
      
      // 处理普通文件拖拽
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          handleFile(files[i]);
        }
      }
    });
    
    // 处理从文件资源管理器拖拽的 URI
    function handleFileUri(uri) {
      // 移除 file:// 前缀
      let filePath = uri;
      if (uri.startsWith('file://')) {
        filePath = decodeURIComponent(uri.replace('file://', ''));
      }
      
      // 获取文件名
      const fileName = filePath.split('/').pop() || filePath.split('\\\\').pop() || 'unknown';
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      
      // 判断是否为图片
      if (isImage(fileName)) {
        // 图片文件：发送消息给扩展读取文件内容
        vscode.postMessage({ command: 'readFile', path: filePath, type: 'image' });
      } else {
        // 非图片文件：直接添加到列表
        const fileData = {
          path: filePath,
          name: fileName,
          size: 0,
          type: '',
          isImage: false,
          id: Date.now() + '_' + Math.random().toString(36).substr(2, 9)
        };
        fileList.push(fileData);
        updateFilePreview();
      }
    }
    
    // 获取文件图标
    function getFileIcon(fileName) {
      const ext = fileName.split('.').pop().toLowerCase();
      const icons = {
        'pdf': '📄', 'doc': '📝', 'docx': '📝', 'txt': '📃',
        'xls': '📊', 'xlsx': '📊', 'csv': '📊',
        'ppt': '📽️', 'pptx': '📽️',
        'zip': '📦', 'rar': '📦', '7z': '📦', 'tar': '📦', 'gz': '📦',
        'js': '💻', 'ts': '💻', 'py': '🐍', 'java': '☕', 'c': '💻', 'cpp': '💻', 'h': '💻',
        'html': '🌐', 'css': '🎨', 'json': '📋', 'xml': '📋', 'yaml': '📋', 'yml': '📋',
        'md': '📖', 'log': '📜',
        'png': '🖼️', 'jpg': '🖼️', 'jpeg': '🖼️', 'gif': '🖼️', 'svg': '🖼️', 'webp': '🖼️', 'bmp': '🖼️',
        'mp3': '🎵', 'wav': '🎵', 'mp4': '🎬', 'avi': '🎬', 'mov': '🎬'
      };
      return icons[ext] || '📁';
    }
    
    // 判断是否为图片
    function isImage(fileName) {
      const ext = fileName.split('.').pop().toLowerCase();
      return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(ext);
    }
    
    // 处理单个文件 - 添加到文件列表
    function handleFile(file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const fileData = {
          base64: e.target.result,
          name: file.name,
          size: file.size,
          type: file.type,
          isImage: file.type.startsWith('image/'),
          id: Date.now() + '_' + Math.random().toString(36).substr(2, 9)
        };
        fileList.push(fileData);
        updateFilePreview();
      };
      reader.readAsDataURL(file);
    }
    
    // 更新文件预览区域
    function updateFilePreview() {
      if (fileList.length === 0) {
        dropText.style.display = 'block';
        imagePreviewContainer.style.display = 'none';
        dropZone.classList.remove('has-image');
        imagesGrid.innerHTML = '';
        imageInfo.textContent = '';
      } else {
        dropText.style.display = 'none';
        imagePreviewContainer.style.display = 'block';
        dropZone.classList.add('has-image');
        
        // 生成文件预览HTML
        imagesGrid.innerHTML = fileList.map((file, index) => {
          if (file.isImage && file.base64) {
            return '<div class="image-item" data-id="' + file.id + '">' +
              '<img src="' + file.base64 + '" class="image-preview" title="' + file.name + '" />' +
              '<button type="button" class="remove-single" data-index="' + index + '">✕</button>' +
            '</div>';
          } else {
            return '<div class="image-item" data-id="' + file.id + '">' +
              '<div class="file-preview" title="' + (file.path || file.name) + '">' +
                '<span class="file-icon">' + getFileIcon(file.name) + '</span>' +
                '<span class="file-name">' + file.name + '</span>' +
              '</div>' +
              '<button type="button" class="remove-single" data-index="' + index + '">✕</button>' +
            '</div>';
          }
        }).join('');
        
        // 显示数量统计
        const imageCount = fileList.filter(f => f.isImage).length;
        const otherCount = fileList.length - imageCount;
        const totalSize = fileList.reduce((sum, f) => sum + (f.size || 0), 0);
        let infoText = '共 ' + fileList.length + ' 个文件';
        if (imageCount > 0 && otherCount > 0) {
          infoText = imageCount + ' 张图片 + ' + otherCount + ' 个文件';
        } else if (imageCount > 0) {
          infoText = imageCount + ' 张图片';
        }
        if (totalSize > 0) infoText += ' (' + formatFileSize(totalSize) + ')';
        imageInfo.textContent = infoText;
        
        // 绑定单个删除按钮事件
        imagesGrid.querySelectorAll('.remove-single').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const index = parseInt(btn.getAttribute('data-index'));
            fileList.splice(index, 1);
            updateFilePreview();
          });
        });
      }
    }
    
    // 接收扩展发来的文件内容
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'fileContent') {
        if (message.type === 'image' && message.base64) {
          const fileData = {
            base64: message.base64,
            name: message.name,
            size: message.size || 0,
            type: 'image',
            isImage: true,
            id: Date.now() + '_' + Math.random().toString(36).substr(2, 9)
          };
          fileList.push(fileData);
          updateFilePreview();
        }
      }
    });
    
    // Format file size
    function formatFileSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }
    
    // 移除全部文件
    removeAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fileList = [];
      updateFilePreview();
    });
    
    // Button handlers
    continueBtn.addEventListener('click', submitContinue);
    endBtn.addEventListener('click', submitEnd);
    
    function submitContinue() {
      let text = textarea.value.trim();
      
      // 如果有文件，将所有文件信息附加到消息中
      if (fileList.length > 0) {
        const uploadType = document.querySelector('input[name="uploadType"]:checked')?.value || 'base64';
        if (uploadType === 'base64') {
          const filesText = fileList.map((f, i) => {
            const icon = f.isImage ? '🖼️' : getFileIcon(f.name);
            return '[已上传' + icon + ' ' + (i + 1) + ': ' + f.name + ' (' + formatFileSize(f.size) + ')]';
          }).join('\\n');
          text = (text ? text + '\\n\\n' : '') + filesText;
        }
      }
      
      // 传递文件数据给扩展后端处理
      const images = fileList.filter(f => f.isImage).map(f => ({ name: f.name, base64: f.base64, size: f.size }));
      const hasImage = images.length > 0;
      
      vscode.postMessage({ command: 'continue', text: text || '继续', hasImage: hasImage, imageCount: images.length, images: images });
    }
    
    function submitEnd() {
      vscode.postMessage({ command: 'end' });
    }
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Start the HTTP server to receive requests from MCP
 */
function startServer(port: number, retryCount = 0): void {
  // 先安全关闭旧服务器
  if (server) {
    try {
      server.close();
    } catch {
      // 忽略关闭错误
    }
    server = null;
  }

  const newServer = http.createServer((req, res) => {
    // Set CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/ask") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });

      req.on("end", async () => {
        try {
          const request = JSON.parse(body) as AskRequest;

          if (request.type === "ask_continue") {
            // Show dialog with error handling
            try {
              // 使用 await 确保 webview 创建完成
              await showAskContinueDialog(request);
              
              // Update request count in sidebar
              statusViewProvider?.incrementRequestCount();

              // Respond that we received the request
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true }));
            } catch (dialogErr) {
              console.error("[Ask Continue] Error showing dialog:", dialogErr);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Failed to show dialog", details: String(dialogErr) }));
            }
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown request type" }));
          }
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  newServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // 端口被占用，尝试下一个端口（最多重试3次）
      if (retryCount < 3) {
        const nextPort = port + 1;
        console.log(`Port ${port} in use, trying ${nextPort}...`);
        setTimeout(() => startServer(nextPort, retryCount + 1), 100);
      } else {
        updateStatusBar(false, port);
        vscode.window.showWarningMessage(
          `Ask Continue: 端口 ${port - 3} - ${port} 均被占用，服务未启动`
        );
      }
    } else {
      updateStatusBar(false, port);
      console.error(`Ask Continue server error: ${err.message}`);
    }
  });

  newServer.listen(port, "127.0.0.1", () => {
    server = newServer;
    console.log(`Ask Continue server listening on port ${port}`);
    updateStatusBar(true, port);
    
    // 写入端口文件，供 MCP 服务器发现
    writePortFile(port);
  });
}

/**
 * 写入端口文件，供 MCP 服务器发现
 */
function writePortFile(port: number): void {
  try {
    if (!fs.existsSync(PORT_FILE_DIR)) {
      fs.mkdirSync(PORT_FILE_DIR, { recursive: true });
    }
    // 使用进程 ID 作为文件名，确保多窗口不冲突
    const portFile = path.join(PORT_FILE_DIR, `${process.pid}.port`);
    fs.writeFileSync(portFile, JSON.stringify({ port, pid: process.pid, time: Date.now() }));
  } catch (e) {
    console.error("Failed to write port file:", e);
  }
}

/**
 * 清理端口文件
 */
function cleanupPortFile(): void {
  try {
    const portFile = path.join(PORT_FILE_DIR, `${process.pid}.port`);
    if (fs.existsSync(portFile)) {
      fs.unlinkSync(portFile);
    }
  } catch (e) {
    // 忽略清理错误
  }
}

/**
 * 清理旧的 MCP 回调端口进程（启动时自动调用）
 */
async function cleanupOldMcpProcesses(): Promise<void> {
  const isWindows = process.platform === "win32";
  
  // 清理端口 23984-24034 范围内的旧进程（MCP 回调端口范围）
  for (let port = 23984; port <= 24034; port++) {
    try {
      if (isWindows) {
        // Windows: 查找并结束占用端口的进程
        exec(`netstat -ano | findstr :${port} | findstr LISTENING`, (err, stdout) => {
          if (!err && stdout) {
            const lines = stdout.trim().split('\n');
            for (const line of lines) {
              const parts = line.trim().split(/\s+/);
              const pid = parts[parts.length - 1];
              if (pid && /^\d+$/.test(pid) && pid !== process.pid.toString()) {
                exec(`taskkill /F /PID ${pid}`, () => {
                  console.log(`[Ask Continue] Killed old MCP process on port ${port} (PID: ${pid})`);
                });
              }
            }
          }
        });
      } else {
        // Unix/Mac: 使用 lsof
        exec(`lsof -ti:${port}`, (err, stdout) => {
          if (!err && stdout) {
            const pids = stdout.trim().split('\n');
            for (const pid of pids) {
              if (pid && pid !== process.pid.toString()) {
                exec(`kill -9 ${pid}`, () => {
                  console.log(`[Ask Continue] Killed old MCP process on port ${port} (PID: ${pid})`);
                });
              }
            }
          }
        });
      }
    } catch (e) {
      // 忽略单个端口清理错误
    }
  }
  
  // 清理旧的端口文件
  try {
    if (fs.existsSync(PORT_FILE_DIR)) {
      const files = fs.readdirSync(PORT_FILE_DIR);
      for (const file of files) {
        if (file.endsWith('.port')) {
          const filePath = path.join(PORT_FILE_DIR, file);
          try {
            const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            // 如果进程已不存在，删除文件
            if (content.pid && content.pid !== process.pid) {
              if (isWindows) {
                exec(`tasklist /FI "PID eq ${content.pid}"`, (err, stdout) => {
                  if (!stdout || !stdout.includes(content.pid.toString())) {
                    fs.unlinkSync(filePath);
                  }
                });
              } else {
                exec(`ps -p ${content.pid}`, (err) => {
                  if (err) {
                    fs.unlinkSync(filePath);
                  }
                });
              }
            }
          } catch {
            fs.unlinkSync(filePath);
          }
        }
      }
    }
  } catch (e) {
    // 忽略清理错误
  }
}

/**
 * Update status bar and sidebar
 */
function updateStatusBar(running: boolean, port?: number): void {
  if (running && port) {
    statusBarItem.text = `$(check) Ask Continue: ${port} | @1837620622`;
    statusBarItem.tooltip = `Ask Continue 正在运行 (端口 ${port})\n二次开发: github.com/1837620622`;
    statusBarItem.backgroundColor = undefined;
    statusViewProvider?.updateStatus(true, port);
  } else {
    statusBarItem.text = "$(x) Ask Continue: 已停止 | @1837620622";
    statusBarItem.tooltip = "Ask Continue 未运行\n二次开发: github.com/1837620622";
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
    statusViewProvider?.updateStatus(false, port || 23983);
  }
}

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): void {
  console.log("Ask Continue extension is now active");

  // Create sidebar view provider
  statusViewProvider = new StatusViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      StatusViewProvider.viewType,
      statusViewProvider
    )
  );

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "askContinue.showStatus";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Get configuration
  const config = vscode.workspace.getConfiguration("askContinue");
  const port = config.get<number>("serverPort", 23983);
  const autoStart = config.get<boolean>("autoStart", true);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("askContinue.showStatus", () => {
      const isRunning = server !== null && server.listening;
      vscode.window.showInformationMessage(
        `Ask Continue 状态: ${isRunning ? `运行中 (端口 ${port})` : "已停止"}`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("askContinue.restart", () => {
      const config = vscode.workspace.getConfiguration("askContinue");
      const port = config.get<number>("serverPort", 23983);
      startServer(port);
      vscode.window.showInformationMessage(`Ask Continue 服务器已重启 (端口 ${port})`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("askContinue.openPanel", () => {
      if (lastPendingRequest) {
        // 检查请求是否过期（10分钟）
        const REQUEST_TIMEOUT = 10 * 60 * 1000; // 10 minutes
        if (Date.now() - lastPendingRequestTime > REQUEST_TIMEOUT) {
          lastPendingRequest = null;
          vscode.window.showWarningMessage("Ask Continue: 待处理的请求已过期");
          return;
        }
        showAskContinueDialog(lastPendingRequest);
      } else {
        vscode.window.showInformationMessage("Ask Continue: 没有待处理的对话请求");
      }
    })
  );

  // 启动时自动清理旧的 MCP 进程
  cleanupOldMcpProcesses().then(() => {
    console.log("[Ask Continue] Old MCP processes cleanup completed");
  });

  // Auto-start server
  if (autoStart) {
    startServer(port);
  } else {
    updateStatusBar(false);
  }

  // Watch for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("askContinue.serverPort")) {
        const newPort = vscode.workspace
          .getConfiguration("askContinue")
          .get<number>("serverPort", 23983);
        startServer(newPort);
      }
    })
  );
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  if (server) {
    server.close();
    server = null;
  }
}
