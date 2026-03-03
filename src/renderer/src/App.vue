<script setup lang="ts">
import { ref, onMounted, nextTick, computed } from 'vue'
import iconFiles from './assets/files.png'
import iconPicture from './assets/picture.png'
import iconSetting from './assets/setting.png'
import iconNewChat from './assets/new-chat.png'
import iconDelete from './assets/delete.png'
import iconSelect from './assets/select.png'
import iconRename from './assets/rename.png'

interface MessageContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: {
    url: string
  }
}

interface AttachedFile {
  name: string
  size: number
  content: string
}

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string | MessageContentPart[]
  files?: AttachedFile[]
}

interface Conversation {
  id: string
  title: string
  messages: Message[]
  updatedAt: number
}

type ServerStatus = 'stopped' | 'starting' | 'running' | 'error'

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string
    }
  }>
}

const conversations = ref<Conversation[]>([])
const currentConversationId = ref<string>('')
const showConversationMenuId = ref<string | null>(null)
const editingConversationId = ref<string | null>(null)
const editingTitle = ref('')

const messages = ref<Message[]>([])
const input = ref('')
const serverStatus = ref<ServerStatus>('stopped')
const serverLogs = ref<string[]>([])
const modelPath = ref('')
const chatContainer = ref<HTMLElement | null>(null)
const isGenerating = ref(false)
const stats = ref({
  contextUsed: 0,
  outputTokens: 0,
  speed: 0
})
let startupTimeout: ReturnType<typeof setTimeout> | null = null

const showSettings = ref(false)
const contextSize = ref(32768)
const maxTokens = ref(-1)

const fileInput = ref<HTMLInputElement | null>(null)
const imageInput = ref<HTMLInputElement | null>(null)
const pendingImage = ref<string | null>(null)
const attachedFiles = ref<File[]>([])
const systemStats = ref({
  memory: { total: 0, used: 0 },
  gpu: { total: 0, used: 0 }
})

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 GB'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

const supportsImages = computed(() => {
  if (!modelPath.value) return false
  const name = modelPath.value.toLowerCase()
  const keywords = [
    'llava',
    'vision',
    'mmproj',
    'minicpmv',
    'qwen2vl',
    'qwen-vl',
    'qwen2.5-vl',
    'internvl',
    'yi-vl',
    'phi-3.5-vision',
    'phi3.5-vision',
    'phi3-vision',
    'gemma3',
    'vl'
  ]
  return keywords.some((k) => name.includes(k))
})

const roleLabel = (role: Message['role']): string => {
  switch (role) {
    case 'user':
      return '我'
    case 'assistant':
      return '助手'
    case 'system':
      return '系统'
  }
}

const statusLabel = (status: ServerStatus): string => {
  switch (status) {
    case 'stopped':
      return '未启动'
    case 'starting':
      return '启动中'
    case 'running':
      return '运行中'
    case 'error':
      return '异常'
  }
}

const handleInputKeydown = (e: KeyboardEvent): void => {
  if (e.key !== 'Enter') return
  if (e.shiftKey) return
  e.preventDefault()
  void sendMessage()
}

const saveConversations = (): void => {
  localStorage.setItem('conversations', JSON.stringify(conversations.value))
}

const loadConversations = (): void => {
  const saved = localStorage.getItem('conversations')
  if (saved) {
    try {
      conversations.value = JSON.parse(saved)
    } catch (e) {
      console.error('Failed to parse conversations', e)
      conversations.value = []
    }
  }
}

const createConversation = (): void => {
  const newConv: Conversation = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2),
    title: '新对话',
    messages: [],
    updatedAt: Date.now()
  }
  conversations.value.unshift(newConv)
  selectConversation(newConv.id)
  saveConversations()
}

const selectConversation = (id: string): void => {
  const conv = conversations.value.find((c) => c.id === id)
  if (conv) {
    currentConversationId.value = id
    messages.value = [...conv.messages] // Clone to avoid direct mutation issues if any
    saveConversations() // Update order or access time if needed, but for now just save state
  }
}

const deleteConversation = (id: string, event?: Event): void => {
  event?.stopPropagation()
  const index = conversations.value.findIndex((c) => c.id === id)
  if (index !== -1) {
    conversations.value.splice(index, 1)
    saveConversations()
    if (currentConversationId.value === id) {
      if (conversations.value.length > 0) {
        selectConversation(conversations.value[0].id)
      } else {
        createConversation()
      }
    }
  }
  showConversationMenuId.value = null
}

const startRenaming = (id: string, currentTitle: string, event?: Event): void => {
  event?.stopPropagation()
  editingConversationId.value = id
  editingTitle.value = currentTitle
  showConversationMenuId.value = null
}

const finishRenaming = (): void => {
  if (editingConversationId.value) {
    const conv = conversations.value.find((c) => c.id === editingConversationId.value)
    if (conv) {
      conv.title = editingTitle.value.trim() || '新对话'
      saveConversations()
    }
    editingConversationId.value = null
  }
}

const toggleMenu = (id: string, event: Event): void => {
  event.stopPropagation()
  showConversationMenuId.value = showConversationMenuId.value === id ? null : id
}

// Close menu when clicking outside
const closeMenu = (): void => {
  showConversationMenuId.value = null
}

const updateCurrentConversation = (): void => {
  const conv = conversations.value.find((c) => c.id === currentConversationId.value)
  if (conv) {
    conv.messages = [...messages.value]
    conv.updatedAt = Date.now()
    // Auto-rename first message if title is default
    if (conv.title === '新对话' && messages.value.length > 0) {
      const firstMsg = messages.value[0]
      if (firstMsg.role === 'user') {
        const text = typeof firstMsg.content === 'string' 
          ? firstMsg.content 
          : (firstMsg.content.find(p => p.type === 'text')?.text || '新对话')
        conv.title = text.slice(0, 20) || '新对话'
      }
    }
    saveConversations()
  }
}

onMounted(async () => {
  // Load settings
  const savedContextSize = localStorage.getItem('contextSize')
  if (savedContextSize) contextSize.value = parseInt(savedContextSize)
  
  const savedMaxTokens = localStorage.getItem('maxTokens')
  if (savedMaxTokens) maxTokens.value = parseInt(savedMaxTokens)

  loadConversations()
  if (conversations.value.length === 0) {
    createConversation()
  } else {
    // Open last conversation or the first one in the list (most recent usually)
    // If we want to persist the exact last open one, we could store 'lastOpenId'
    // But loading the first one (most recent) is good enough for now.
    selectConversation(conversations.value[0].id)
  }

  window.addEventListener('click', closeMenu)


  const isRunning = await window.api.checkServerStatus()
  if (isRunning) {
    serverStatus.value = 'running'
    addLog('服务已在运行。')
  }

  window.api.onServerLog((log) => {
    serverLogs.value.push(log)
    // Auto-scroll logs
    if (serverLogs.value.length > 100) serverLogs.value.shift()

    // Check for successful startup indicators
    if (log.includes('HTTP server listening') || log.includes('server is listening')) {
      serverStatus.value = 'running'
      if (startupTimeout) {
        clearTimeout(startupTimeout)
        startupTimeout = null
      }
    }

    // Check for error indicators
    if (log.includes('error') || log.includes('failed') || log.includes('exception')) {
      if (serverStatus.value === 'starting') {
        serverStatus.value = 'error'
      }
    }
  })

  // Poll system stats
  setInterval(async () => {
    try {
      const stats = await window.api.getSystemStats()
      if (stats) {
        systemStats.value = stats
      }
    } catch (e) {
      console.error('Failed to get system stats', e)
    }
  }, 2000)
})

const addLog = (msg: string): void => {
  serverLogs.value.push(msg)
}

const selectModel = async (): Promise<void> => {
  const path = await window.api.selectModel()
  if (path) {
    modelPath.value = path
    addLog(`已选择模型：${path}`)
  }
}

const startServer = async (): Promise<void> => {
  if (!modelPath.value) {
    alert('请先选择模型')
    return
  }
  serverStatus.value = 'starting'
  addLog('正在启动服务...')

  // Set a timeout to detect startup failure
  startupTimeout = setTimeout(() => {
    if (serverStatus.value === 'starting') {
      serverStatus.value = 'error'
      addLog('服务启动超时（30 秒）')
    }
  }, 30000)

  const result = await window.api.startServer(modelPath.value, contextSize.value)
  if (!result.success) {
    serverStatus.value = 'error'
    addLog(result.message)
    if (startupTimeout) clearTimeout(startupTimeout)
    startupTimeout = null
  } else {
    // Clear timeout on successful start (will be cleared when status changes to running)
    // Keep the timeout active to catch cases where server starts but doesn't become ready
  }
}

const stopServer = async (): Promise<void> => {
  await window.api.stopServer()
  serverStatus.value = 'stopped'
  addLog('服务已停止')
}

const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message
  return String(err)
}

const tryParseJson = (text: string): unknown | null => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

const getPromptTokenCount = async (messages: any[]): Promise<number> => {
  try {
    // Combine all messages into a single string for approximation
    const content = messages.map((m) => {
      if (typeof m.content === 'string') return m.content
      if (Array.isArray(m.content)) {
        return m.content.map((c: any) => c.text || '').join('\n')
      }
      return ''
    }).join('\n\n')

    const response = await fetch('http://127.0.0.1:8080/tokenize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })

    if (!response.ok) return 0
    const data = await response.json()
    return data.tokens ? data.tokens.length : 0
  } catch {
    return 0
  }
}

const sendMessage = async (): Promise<void> => {
  if ((!input.value.trim() && !pendingImage.value && attachedFiles.value.length === 0) || isGenerating.value) return

  let userMsgContent: string | MessageContentPart[] = input.value
  const messageFiles: AttachedFile[] = []

  if (attachedFiles.value.length > 0) {
    for (const file of attachedFiles.value) {
      try {
        const text = await file.text()
        messageFiles.push({
          name: file.name,
          size: file.size,
          content: text
        })
      } catch {
        addLog(`读取文件失败: ${file.name}`)
      }
    }
  }

  const userMsg: Message = {
    role: 'user',
    content: userMsgContent,
    files: messageFiles.length > 0 ? messageFiles : undefined
  }

  if (pendingImage.value) {
    if (typeof userMsgContent === 'string') {
      userMsg.content = [
        { type: 'text', text: userMsgContent },
        { type: 'image_url', image_url: { url: pendingImage.value } }
      ]
    } else {
      if (Array.isArray(userMsg.content)) {
        userMsg.content.push({ type: 'image_url', image_url: { url: pendingImage.value } })
      } else {
        userMsg.content = [
          { type: 'text', text: userMsg.content },
          { type: 'image_url', image_url: { url: pendingImage.value } }
        ]
      }
    }
  }

  messages.value.push(userMsg)
  updateCurrentConversation()
  
  attachedFiles.value = []
  pendingImage.value = null
  input.value = ''
  isGenerating.value = true

  await nextTick()
  scrollToBottom()

  try {
    const requestMessages = messages.value.map((m) => {
      let contentToSend = m.content

      if (m.files && m.files.length > 0) {
        const fileText = m.files
          .map((f) => `\n[文件内容: ${f.name}]\n${f.content}\n[文件结束]`)
          .join('\n')
        if (typeof contentToSend === 'string') {
          contentToSend = (fileText + '\n\n' + contentToSend).trim()
        } else if (Array.isArray(contentToSend)) {
          contentToSend = [...contentToSend]
          const textPartIndex = contentToSend.findIndex((p) => p.type === 'text')
          if (textPartIndex !== -1) {
            const originalText = contentToSend[textPartIndex].text || ''
            contentToSend[textPartIndex] = {
              ...contentToSend[textPartIndex],
              text: (fileText + '\n\n' + originalText).trim()
            }
          } else {
            contentToSend.unshift({ type: 'text', text: fileText })
          }
        }
      }

      if (Array.isArray(contentToSend)) {
        return { role: m.role, content: contentToSend }
      }
      return { role: m.role, content: contentToSend }
    })

    // Calculate prompt tokens
    const promptTokens = await getPromptTokenCount(requestMessages)
    stats.value.contextUsed = promptTokens
    stats.value.outputTokens = 0
    stats.value.speed = 0
    const startTime = Date.now()

    // Try OpenAI compatible endpoint first
    const response = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: requestMessages,
        stream: true,
        max_tokens: maxTokens.value
      })
    })

    if (!response.ok) {
      throw new Error(`服务返回状态码 ${response.status}`)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('响应内容为空')

    const assistantMsg = { role: 'assistant', content: '' } as Message
    messages.value.push(assistantMsg)
    updateCurrentConversation()

    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value)
      const lines = chunk.split('\n')

      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          const data = tryParseJson(line.slice(6)) as ChatCompletionChunk | null
          const content = data?.choices?.[0]?.delta?.content ?? ''
          if (typeof assistantMsg.content === 'string') {
            assistantMsg.content += content
            
            // Update stats
            if (content) {
              // Approximate 1 token per chunk or use length? 
              // llama.cpp streams token by token usually.
              // If content length is small, treat as 1 token.
              // If large, maybe more.
              // For simplicity and "real-time" feel, increment by 1 for each non-empty chunk event if content length > 0.
              // But a chunk might contain multiple tokens if buffer is large.
              // Let's use a rough estimate based on characters for speed if needed, 
              // but since we want "tokens", counting chunks is the standard way for streamed responses unless usage is provided.
              // However, data chunks might be combined in the network buffer.
              // A better heuristic: 1 token ~= 4 chars (English), 1 char (Chinese).
              // Let's just increment by 1 for now as it's the safest assumption for stream events from llama.cpp.
              stats.value.outputTokens++
              stats.value.contextUsed++
              
              const elapsed = (Date.now() - startTime) / 1000
              if (elapsed > 0) {
                stats.value.speed = stats.value.outputTokens / elapsed
              }
            }
          }
          scrollToBottom()
        }
      }
    }
  } catch (err: unknown) {
    const msg = getErrorMessage(err)
    addLog(`发送消息失败：${msg}`)
    messages.value.push({ role: 'system', content: `错误：${msg}` })
  } finally {
    isGenerating.value = false
    updateCurrentConversation()
    scrollToBottom()
  }
}

const handleFileUpload = async (event: Event): Promise<void> => {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    if (text.slice(0, 1000).includes('\0')) {
      alert('暂不支持二进制文件，请上传文本文件。')
      return
    }
    attachedFiles.value.push(file)
    addLog(`已添加文件：${file.name}`)
  } catch (err) {
    alert('读取文件失败')
    addLog(`读取文件失败：${getErrorMessage(err)}`)
  } finally {
    target.value = ''
  }
}

const removeFile = (index: number): void => {
  attachedFiles.value.splice(index, 1)
}

const handleImageUpload = (event: Event): void => {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return

  if (!file.type.startsWith('image/')) {
    alert('请选择图片文件')
    return
  }

  const reader = new FileReader()
  reader.onload = (e) => {
    pendingImage.value = e.target?.result as string
    addLog(`已加载图片：${file.name}`)
  }
  reader.readAsDataURL(file)
  target.value = ''
}

const clearPendingImage = (): void => {
  pendingImage.value = null
}

const saveSettings = (): void => {
  localStorage.setItem('contextSize', contextSize.value.toString())
  localStorage.setItem('maxTokens', maxTokens.value.toString())
  showSettings.value = false
  if (serverStatus.value === 'running') {
    alert('设置已保存。注意：上下文长度的修改需要重启服务才能生效。')
  }
}

const scrollToBottom = (): void => {
  if (chatContainer.value) {
    chatContainer.value.scrollTop = chatContainer.value.scrollHeight
  }
}

const vFocus = {
  mounted: (el: HTMLElement) => el.focus()
}
</script>

<template>
  <div class="app-container">
    <div class="title-bar">
      <div class="app-title-area">
        <span class="app-title">AI助手</span>
        <span class="status-badge" :class="serverStatus">{{ statusLabel(serverStatus) }}</span>
      </div>
      <div class="title-stats-display">
        <span>内存 : {{ formatBytes(systemStats.memory.used) }}/{{ formatBytes(systemStats.memory.total) }}</span>
        <span v-if="systemStats.gpu.total > 0">显存 : {{ formatBytes(systemStats.gpu.used) }}/{{ formatBytes(systemStats.gpu.total) }}</span>
      </div>
      <button class="icon-btn setting-btn" @click="showSettings = true" title="设置">
        <img :src="iconSetting" alt="Settings" />
      </button>
    </div>
    <div class="sidebar">
      <button class="new-chat-btn" @click="createConversation">
        <img :src="iconNewChat" alt="New Chat" />
        <span>新对话</span>
      </button>

      <div class="conversation-list">
        <div class="list-header">历史对话</div>
        <div 
          v-for="conv in conversations" 
          :key="conv.id" 
          class="conversation-item"
          :class="{ active: currentConversationId === conv.id }"
          @click="selectConversation(conv.id)"
        >
          <div class="conversation-title" v-if="editingConversationId !== conv.id">
            {{ conv.title }}
          </div>
          <input 
            v-else
            v-model="editingTitle"
            class="rename-input"
            @click.stop
            @blur="finishRenaming"
            @keyup.enter="finishRenaming"
            v-focus
          />
          
          <button class="menu-btn" @click="(e) => toggleMenu(conv.id, e)" title="选项">
            <img :src="iconSelect" alt="Options" style="width: 16px; height: 16px; opacity: 0.6;" />
          </button>

          <div v-if="showConversationMenuId === conv.id" class="conversation-menu">
            <button @click="(e) => startRenaming(conv.id, conv.title, e)">
               <img :src="iconRename" alt="Rename" />
               重命名
            </button>
            <button class="delete-item-btn" @click="(e) => deleteConversation(conv.id, e)">
               <img :src="iconDelete" alt="Delete" />
               删除
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="main-content">
      <div class="top-controls">
        <div class="control-group-horizontal">
          <button
            class="control-btn"
            :disabled="serverStatus === 'running' || serverStatus === 'starting'"
            @click="selectModel"
          >
            选择模型
          </button>
          <div v-if="modelPath" class="model-path-display" :title="modelPath">
            {{ modelPath.split('\\').pop() }}
          </div>
          <button
            class="control-btn primary-btn"
            :disabled="serverStatus === 'running' || serverStatus === 'starting' || !modelPath"
            @click="startServer"
          >
            启动服务
          </button>
          <button class="control-btn stop-btn" :disabled="serverStatus === 'stopped'" @click="stopServer">
            停止服务
          </button>
        </div>
        
      </div>

      <div ref="chatContainer" class="chat-area">
        <div v-if="messages.length === 0" class="empty-state">
          先选择模型并启动服务，然后开始对话。
        </div>
        <div v-for="(msg, i) in messages" :key="i" class="message" :class="msg.role">
          <div class="message-role">{{ roleLabel(msg.role) }}</div>
          <div class="message-content">
            <div v-if="msg.files && msg.files.length > 0" class="message-files">
              <div v-for="(file, fIndex) in msg.files" :key="fIndex" class="file-card">
                <div class="file-icon">
                  <img :src="iconFiles" alt="file" />
                </div>
                <div class="file-info">
                  <div class="file-name" :title="file.name">{{ file.name }}</div>
                  <div class="file-size">{{ (file.size / 1024).toFixed(1) }} KB</div>
                </div>
              </div>
            </div>

            <template v-if="Array.isArray(msg.content)">
              <div v-for="(part, idx) in msg.content" :key="idx">
                <div v-if="part.type === 'text'" style="white-space: pre-wrap">{{ part.text }}</div>
                <img
                  v-if="part.type === 'image_url'"
                  :src="part.image_url?.url"
                  class="message-image"
                />
              </div>
            </template>
            <template v-else>
              <div style="white-space: pre-wrap">{{ msg.content }}</div>
            </template>
          </div>
        </div>
      </div>

      <div class="input-container">
        <div v-if="attachedFiles.length > 0" class="file-preview-area">
          <div v-for="(file, index) in attachedFiles" :key="index" class="file-card">
            <div class="file-icon">
              <img :src="iconFiles" alt="file" />
            </div>
            <div class="file-info">
              <div class="file-name" :title="file.name">{{ file.name }}</div>
              <div class="file-size">{{ (file.size / 1024).toFixed(1) }} KB</div>
            </div>
            <button class="remove-file-btn" @click="removeFile(index)">×</button>
          </div>
        </div>

        <div v-if="pendingImage" class="image-preview">
          <img :src="pendingImage" alt="Preview" />
          <button class="close-btn" @click="clearPendingImage">×</button>
        </div>

        <div v-if="serverStatus === 'running' && (isGenerating || stats.contextUsed > 0)" class="stats-bar">
          <span class="stat-item">
            Context: {{ stats.contextUsed }}/{{ contextSize }} ({{ Math.round(stats.contextUsed / contextSize * 100) }}%)
          </span>
          <span class="stat-item">
            Output: {{ stats.outputTokens }}/{{ maxTokens === -1 ? '∞' : maxTokens }}
          </span>
          <span class="stat-item">
            {{ stats.speed.toFixed(1) }} t/s
          </span>
        </div>

        <div class="input-area">
          <textarea
            v-model="input"
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            :disabled="serverStatus !== 'running' || isGenerating"
            @keydown="handleInputKeydown"
          ></textarea>
          
          <input type="file" ref="fileInput" @change="handleFileUpload" style="display: none" />
          <input
            type="file"
            ref="imageInput"
            @change="handleImageUpload"
            accept="image/*"
            style="display: none"
          />

          <div class="action-buttons">
            <button class="icon-btn" @click="() => fileInput?.click()" title="上传文件" :disabled="serverStatus !== 'running'">
              <img :src="iconFiles" alt="文件" />
              <span>文件</span>
            </button>
            <button
              v-if="supportsImages"
              class="icon-btn"
              @click="() => imageInput?.click()"
              title="上传图片"
              :disabled="serverStatus !== 'running'"
            >
              <img :src="iconPicture" alt="图片" />
              <span>图片</span>
            </button>
          </div>

          <button
            class="send-btn"
            :disabled="serverStatus !== 'running' || isGenerating"
            @click="sendMessage"
          >
            {{ isGenerating ? '生成中...' : '发送' }}
          </button>
        </div>
      </div>
    </div>
    <div v-if="showSettings" class="settings-overlay">
      <div class="settings-modal">
        <h3>设置</h3>
        
        <div class="setting-item">
          <label>上下文长度 (Context Size)</label>
          <div class="setting-desc">影响模型能记住的对话长度。修改后需重启服务。</div>
          <select v-model="contextSize">
            <option :value="8192">8192 (8k)</option>
            <option :value="16384">16384 (16k)</option>
            <option :value="32768">32768 (32k 默认)</option>
            <option :value="102400">102400 (100k)</option>
            <option :value="204800">204800 (200k)</option>
          </select>
        </div>

        <div class="setting-item">
          <label>最大输出 Token (Max Tokens)</label>
          <div class="setting-desc">限制单次回复的长度。设为 -1 表示不限制。</div>
          <input type="number" v-model="maxTokens" placeholder="-1" />
        </div>

        <div class="settings-actions">
          <button @click="showSettings = false">取消</button>
          <button class="primary-btn" @click="saveSettings">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
html,
body,
#app {
  height: 100%;
  margin: 0;
  padding: 0;
  font-family: 'Microsoft YaHei', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  overflow: hidden;
}

.title-bar {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 40px;
  -webkit-app-region: drag;
  z-index: 5000;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 140px 0 16px;
  box-sizing: border-box;
  background: #f7f9fc;
  border-bottom: 1px solid #e6e8eb;
}

.app-title-area {
  display: flex;
  align-items: center;
  gap: 12px;
}

.title-stats-display {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 20px;
  font-size: 13px;
  color: #1f2328;
  font-family: 'Consolas', monospace;
  font-weight: 500;
  white-space: nowrap;
}

.app-title {
  font-weight: bold;
  font-size: 14px;
  color: #1f2328;
}

.status-badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 12px;
  color: white;
  font-weight: 500;
}

.status-badge.stopped {
  background-color: #6c757d;
}
.status-badge.starting {
  background-color: #ffc107;
  color: black;
}
.status-badge.running {
  background-color: #28a745;
}
.status-badge.error {
  background-color: #dc3545;
}

.title-bar .setting-btn {
  -webkit-app-region: no-drag;
  color: #57606a;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.title-bar .setting-btn:hover {
  background-color: rgba(0, 0, 0, 0.05);
  border-radius: 4px;
}

.title-bar .setting-btn img {
  filter: none;
  width: 18px;
  height: 18px;
  opacity: 0.7;
}

.app-container {
  display: flex;
  height: 100vh;
  width: 100vw;
  background-color: #ffffff;
  color: #1f2328;
  padding-top: 40px;
  box-sizing: border-box;
}

.sidebar {
  width: 260px;
  background: #f7f9fc;
  border-right: 1px solid #e6e8eb;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow: hidden;
}

.new-chat-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background-color: white;
  border: 1px solid #e6e8eb;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  color: #1f2328;
  transition: all 0.2s;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.new-chat-btn:hover {
  background-color: #f6f8fa;
  border-color: #d0d7de;
}

.new-chat-btn img {
  width: 16px;
  height: 16px;
  opacity: 0.8;
}

.conversation-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}

.list-header {
  font-size: 12px;
  font-weight: 600;
  color: #656d76;
  padding: 0 8px 8px;
  text-transform: uppercase;
}

.conversation-item {
  position: relative;
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  color: #1f2328;
  transition: background-color 0.2s;
  height: 36px;
}

.conversation-item:hover {
  background-color: #eaeef2;
}

.conversation-item.active {
  background-color: #e5eefc;
  color: #0969da;
}

.conversation-title {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-right: 24px;
}

.rename-input {
  flex: 1;
  padding: 4px 8px;
  border: 1px solid #0969da;
  border-radius: 4px;
  font-size: 14px;
  outline: none;
  width: 100%;
}

.menu-btn {
  position: absolute;
  right: 8px;
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: none; /* Hide by default */
  color: #656d76;
  align-items: center;
  justify-content: center;
}

.conversation-item:hover .menu-btn,
.conversation-item.active .menu-btn,
.conversation-menu { /* Keep visible if menu is open */
  display: flex;
}

.menu-btn:hover {
  background-color: rgba(0, 0, 0, 0.1);
}

.conversation-menu {
  position: absolute;
  top: 100%;
  right: 0;
  background: white;
  border: 1px solid #e6e8eb;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  min-width: 120px;
  padding: 4px;
}

.conversation-menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
  font-size: 13px;
  color: #1f2328;
  border-radius: 4px;
}

.conversation-menu button:hover {
  background-color: #0969da;
  color: white;
}

.conversation-menu button img {
  width: 14px;
  height: 14px;
  opacity: 0.7;
}

.conversation-menu button:hover img {
  opacity: 1;
  filter: brightness(0) invert(1);
}

.delete-item-btn {
  color: #cf222e !important;
}

.delete-item-btn:hover {
  background-color: #cf222e !important;
  color: white !important;
}

/* Scrollbar styling for list */
.conversation-list::-webkit-scrollbar {
  width: 6px;
}
.conversation-list::-webkit-scrollbar-track {
  background: transparent;
}
.conversation-list::-webkit-scrollbar-thumb {
  background-color: rgba(0, 0, 0, 0.1);
  border-radius: 3px;
}
.conversation-list::-webkit-scrollbar-thumb:hover {
  background-color: rgba(0, 0, 0, 0.2);
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
}

.top-controls {
  padding: 12px 16px;
  background-color: #ffffff;
  border-bottom: 1px solid #e6e8eb;
  display: flex;
  align-items: center;
}

.control-group-horizontal {
  display: flex;
  align-items: center;
  gap: 10px;
}

.control-btn {
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
  background-color: #f6f8fa;
  color: #24292f;
  border: 1px solid #d0d7de;
  cursor: pointer;
  white-space: nowrap;
}

.control-btn:hover:not(:disabled) {
  background-color: #f3f4f6;
  border-color: #1f6feb;
  color: #1f6feb;
}

.control-btn.primary-btn {
  background-color: #1f6feb;
  color: white;
  border: 1px solid #1f6feb;
}
.control-btn.primary-btn:hover:not(:disabled) {
  background-color: #1a5fd0;
}

.control-btn.stop-btn {
  background-color: #cf222e;
  color: white;
  border: 1px solid #cf222e;
}
.control-btn.stop-btn:hover:not(:disabled) {
  background-color: #a40e26;
}

.model-path-display {
  flex: 1;
  font-size: 12px;
  color: #57606a;
  background-color: #f6f8fa;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid #d0d7de;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 300px;
}


.chat-area {
  flex: 1;
  padding: 18px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background-color: #f7f9fc;
}

.empty-state {
  text-align: center;
  color: #7a869a;
  margin-top: 120px;
}

.message {
  max-width: 80%;
  padding: 10px 14px;
  border-radius: 12px;
  line-height: 1.5;
  position: relative;
  box-shadow:
    0 1px 0 rgba(16, 24, 40, 0.02),
    0 4px 14px rgba(16, 24, 40, 0.06);
}

.message-role {
  font-size: 12px;
  margin-bottom: 4px;
  opacity: 0.75;
}

.message.user {
  align-self: flex-end;
  background-color: #ffffff;
  color: #1f2328;
  border-bottom-right-radius: 2px;
}

.message.assistant {
  align-self: flex-start;
  background-color: #ffffff;
  color: #1f2328;
  border-bottom-left-radius: 2px;
}

.message.system {
  align-self: center;
  background-color: #fff6db;
  font-size: 0.9em;
  color: #7a5d00;
  border: 1px solid #ffe7a3;
}

.message-image {
  max-width: 100%;
  border-radius: 8px;
  margin-top: 8px;
  display: block;
}

.message-files {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.input-container {
  background-color: #ffffff;
  border-top: 1px solid #e6e8eb;
  display: flex;
  flex-direction: column;
}

.file-preview-area {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 16px 0;
}

.file-card {
  display: flex;
  align-items: center;
  background-color: #f3f4f6;
  border-radius: 8px;
  padding: 8px 12px;
  position: relative;
  max-width: 240px;
  border: 1px solid #e6e8eb;
}

.file-icon {
  width: 32px;
  height: 32px;
  background-color: #e6f0ff;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 10px;
}

.file-icon img {
  width: 20px;
  height: 20px;
  object-fit: contain;
}

.file-info {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  margin-right: 24px;
}

.file-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #1f2328;
}

.file-size {
  font-size: 11px;
  color: #6e7781;
}

.remove-file-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 16px;
  height: 16px;
  background: transparent;
  color: #6e7781;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  line-height: 1;
  padding: 0;
  border-radius: 50%;
}

.remove-file-btn:hover {
  background-color: rgba(0, 0, 0, 0.1);
  color: #1f2328;
}

.image-preview {
  padding: 8px 16px;
  background-color: #f0f2f5;
  border-bottom: 1px solid #e6e8eb;
  position: relative;
  display: inline-block;
  align-self: flex-start;
  margin: 8px 16px 0;
  border-radius: 8px;
}

.image-preview img {
  height: 80px;
  border-radius: 4px;
  display: block;
}

.image-preview .close-btn {
  position: absolute;
  top: -8px;
  right: -8px;
  width: 20px;
  height: 20px;
  background: #ff4d4f;
  color: white;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  padding: 0;
}

.input-area {
  padding: 14px 16px;
  display: flex;
  gap: 12px;
  align-items: flex-end;
}

.action-buttons {
  display: flex;
  gap: 8px;
}

.icon-btn {
  background: none;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 6px 10px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 11px;
  color: #24292f;
  transition: all 0.2s;
  min-width: 50px;
}

.icon-btn:hover {
  background-color: #f3f4f6;
  border-color: #1f6feb;
  color: #1f6feb;
}

.icon-btn img {
  width: 20px;
  height: 20px;
  object-fit: contain;
}

textarea {
  flex: 1;
  min-height: 44px;
  height: 88px;
  resize: none;
  padding: 10px 12px;

  border: 1px solid #d0d7de;
  border-radius: 10px;
  font-family: inherit;
  outline: none;
  background-color: #ffffff;
  line-height: 1.5;
}

textarea:focus {
  border-color: #1f6feb;
  box-shadow: 0 0 0 3px rgba(31, 111, 235, 0.16);
}

button {
  padding: 10px 14px;
  background-color: #1f6feb;
  color: white;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  transition:
    background-color 0.2s,
    transform 0.05s;
}

button:hover:not(:disabled) {
  background-color: #1a5fd0;
}

button:active:not(:disabled) {
  transform: translateY(1px);
}

button:disabled {
  background-color: #9ca3af;
  cursor: not-allowed;
  opacity: 1;
  color: #f3f4f6;
}

.send-btn {
  height: 44px;
  min-width: 92px;
}

.stop-btn {
  background-color: #dc3545;
}

.stop-btn:hover:not(:disabled) {
  background-color: #bd2130;
}

.status-indicator {
  padding: 8px;
  border-radius: 4px;
  font-weight: bold;
  text-align: center;
  font-size: 13px;
}
.status-indicator.stopped {
  background-color: #6c757d;
}
.status-indicator.starting {
  background-color: #ffc107;
  color: black;
}
.status-indicator.running {
  background-color: #28a745;
}
.status-indicator.error {
  background-color: #dc3545;
}

.stats-bar {
  display: flex;
  justify-content: center;
  gap: 24px;
  padding: 8px 16px 0;
  font-size: 12px;
  color: #6e7781;
  font-family: 'Consolas', 'Monaco', monospace;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 4px;
}
.control-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.logs {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 150px;
  margin-top: auto;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  padding-top: 10px;
}

.logs h3 {
  margin: 0 0 5px 0;
  font-size: 13px;
}

.log-content {
  flex: 1;
  overflow-y: auto;
  background-color: rgba(0, 0, 0, 0.3);
  padding: 8px;
  font-family: 'Consolas', monospace;
  font-size: 11px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-all;
}

.model-path {
  font-size: 12px;
  word-break: break-all;
  color: #ced4da;
  background: rgba(0, 0, 0, 0.2);
  padding: 5px;
  border-radius: 4px;
}

.settings-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.settings-modal {
  background-color: white;
  padding: 24px;
  border-radius: 12px;
  width: 400px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
}

.settings-modal h3 {
  margin-top: 0;
  margin-bottom: 20px;
  font-size: 18px;
  color: #1f2328;
}

.setting-item {
  margin-bottom: 20px;
}

.setting-item label {
  display: block;
  font-weight: 500;
  margin-bottom: 6px;
  color: #1f2328;
}

.setting-desc {
  font-size: 12px;
  color: #6e7781;
  margin-bottom: 8px;
}

.setting-item select,
.setting-item input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  font-size: 14px;
  box-sizing: border-box;
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 24px;
}

.settings-actions button {
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid #d0d7de;
  background-color: white;
  color: #1f2328;
  font-size: 14px;
}

.settings-actions button.primary-btn {
  background-color: #1f6feb;
  color: white;
  border-color: #1f6feb;
}

.settings-actions button:hover {
  opacity: 0.9;
}
</style>
