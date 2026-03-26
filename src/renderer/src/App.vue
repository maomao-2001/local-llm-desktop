﻿﻿﻿﻿﻿<script setup lang="ts">
import { ref, onMounted, nextTick, computed } from 'vue'
import iconFiles from './assets/files.png'
import iconPicture from './assets/picture.png'
import iconSetting from './assets/setting.png'
import iconNewChat from './assets/new-chat.png'
import iconDelete from './assets/delete.png'
import iconSelect from './assets/select.png'
import iconRename from './assets/rename.png'
import {
  AUTO_SCROLL_THRESHOLD,
  CONTEXT_SIZE_STORAGE_KEY,
  MAX_TOKENS_STORAGE_KEY,
  MODEL_PATH_STORAGE_KEY,
  SERVER_BASE_URL
} from './constants/chat'
import { useConversationManager } from './composables/useConversationManager'
import type {
  AttachedFile,
  ChatCompletionChunk,
  ChatCompletionDeltaPart,
  Message,
  MessageContentPart,
  ServerStatus
} from './types/chat'

const {
  conversations,
  currentConversationId,
  messages,
  loadConversations,
  createConversation,
  selectConversation,
  deleteConversation: removeConversation,
  renameConversation,
  updateCurrentConversation
} = useConversationManager()
const showConversationMenuId = ref<string | null>(null)
const editingConversationId = ref<string | null>(null)
const editingTitle = ref('')
const input = ref('')
const serverStatus = ref<ServerStatus>('stopped')
const serverLogs = ref<string[]>([])
const modelPath = ref('')
const chatContainer = ref<HTMLElement | null>(null)
const inputTextarea = ref<HTMLTextAreaElement | null>(null)
const shouldAutoScroll = ref(true)
const isGenerating = ref(false)
const currentRequestController = ref<AbortController | null>(null)
const stats = ref({
  promptTokens: 0,
  contextUsed: 0,
  reasoningTokens: 0,
  responseTokens: 0,
  outputTokens: 0,
  speed: 0
})
let startupTimeout: ReturnType<typeof setTimeout> | null = null

const showSettings = ref(false)
const contextSize = ref(131072)
const maxTokens = ref(-1)
const contextSizeOptions = [
  { value: 32768, label: '32k' },
  { value: 65536, label: '64k' },
  { value: 131072, label: '128k' },
  { value: 262144, label: '256k' }
] as const

const fileInput = ref<HTMLInputElement | null>(null)
const imageInput = ref<HTMLInputElement | null>(null)
const pendingImage = ref<string | null>(null)
const attachedFiles = ref<File[]>([])
const systemStats = ref({
  memory: { total: 0, used: 0 },
  gpu: { total: 0, used: 0 }
})

const currentModelName = computed(() => {
  return modelPath.value.split('\\').pop() ?? ''
})

const memoryUsagePercent = computed(() => {
  const total = systemStats.value.memory.total
  if (!total) return 0
  return Math.min(100, Math.round((systemStats.value.memory.used / total) * 100))
})

const gpuUsagePercent = computed(() => {
  const total = systemStats.value.gpu.total
  if (!total) return 0
  return Math.min(100, Math.round((systemStats.value.gpu.used / total) * 100))
})

const contextUsagePercent = computed(() => {
  if (!contextSize.value) return 0
  return Math.min(100, Math.round((stats.value.contextUsed / contextSize.value) * 100))
})

const isAbortError = (err: unknown): boolean => {
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  return false
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
    'qwen3.5',
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

const mainViewState = computed<'setup' | 'loading' | 'chat'>(() => {
  if (serverStatus.value === 'running') return 'chat'
  if (serverStatus.value === 'starting') return 'loading'
  return 'setup'
})

const lastServerLog = computed(() => {
  return [...serverLogs.value].reverse().find((log) => log.trim().length > 0) ?? ''
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

const normalizeContextSize = (value: number): number => {
  return contextSizeOptions.some((option) => option.value === value) ? value : 131072
}

const handleInputKeydown = (e: KeyboardEvent): void => {
  if (e.key !== 'Enter') return
  if (e.isComposing) return
  if (e.shiftKey) {
    e.preventDefault()
    const target = e.target instanceof HTMLTextAreaElement ? e.target : inputTextarea.value
    if (!target) return
    const selectionStart = target.selectionStart ?? input.value.length
    const selectionEnd = target.selectionEnd ?? input.value.length
    input.value =
      input.value.slice(0, selectionStart) + '\n' + input.value.slice(selectionEnd)
    void nextTick(() => {
      target.focus()
      target.setSelectionRange(selectionStart + 1, selectionStart + 1)
    })
    return
  }
  e.preventDefault()
  void sendMessage()
}

const stopGenerating = (): void => {
  if (!isGenerating.value) return
  currentRequestController.value?.abort()
}

const deleteConversation = (id: string, event?: Event): void => {
  event?.stopPropagation()
  removeConversation(id)
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
    renameConversation(editingConversationId.value, editingTitle.value)
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

onMounted(async () => {
  // Load settings
  const savedContextSize = localStorage.getItem(CONTEXT_SIZE_STORAGE_KEY)
  if (savedContextSize) contextSize.value = normalizeContextSize(parseInt(savedContextSize))
  
  const savedMaxTokens = localStorage.getItem(MAX_TOKENS_STORAGE_KEY)
  if (savedMaxTokens) maxTokens.value = parseInt(savedMaxTokens)

  const savedModelPath = localStorage.getItem(MODEL_PATH_STORAGE_KEY)
  if (savedModelPath) {
    modelPath.value = savedModelPath
    addLog(`已恢复模型：${savedModelPath}`)
  }

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
  const path = await window.api.selectModel(modelPath.value || undefined)
  if (path) {
    modelPath.value = path
    localStorage.setItem(MODEL_PATH_STORAGE_KEY, path)
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

const parseErrorDetail = (text: string): string => {
  const parsed = tryParseJson(text) as
    | { error?: { message?: string } | string; message?: string }
    | null

  if (typeof parsed?.error === 'string') return parsed.error
  if (typeof parsed?.error === 'object' && typeof parsed.error?.message === 'string') {
    return parsed.error.message
  }
  if (typeof parsed?.message === 'string') return parsed.message
  return text.trim()
}

const parseDeltaText = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object') {
        const p = part as ChatCompletionDeltaPart
        return p.text ?? p.content ?? ''
      }
      return ''
    })
    .join('')
}

const toggleReasoning = (index: number): void => {
  const msg = messages.value[index]
  if (!msg || msg.role !== 'assistant' || !msg.reasoning) return
  msg.reasoningExpanded = !msg.reasoningExpanded
  updateCurrentConversation()
}

const isReasoningStreaming = (index: number): boolean => {
  const msg = messages.value[index]
  return Boolean(
    msg &&
      msg.role === 'assistant' &&
      isGenerating.value &&
      index === messages.value.length - 1 &&
      msg.reasoning
  )
}

const reasoningLabel = (index: number): string => {
  return isReasoningStreaming(index) ? '思考中' : '思考过程'
}

const reasoningPreview = (reasoning: string | undefined, index: number): string => {
  const text = (reasoning ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return isReasoningStreaming(index) ? '正在整理回答…' : '查看本次思路'
  return text.length > 38 ? `${text.slice(0, 38)}…` : text
}

const estimateTokenCount = (content: string): number => {
  const normalized = content.trim()
  if (!normalized) return 0
  const cjkChars = normalized.match(/[\u3400-\u9fff]/g) ?? []
  const latinWords = normalized
    .replace(/[\u3400-\u9fff]/g, ' ')
    .split(/[\s,.;:!?()[\]{}"'`~<>\\/|+\-=_*#%&^]+/)
    .filter(Boolean)
  return cjkChars.length + latinWords.length
}

const getTextTokenCount = async (content: string, signal?: AbortSignal): Promise<number> => {
  try {
    const response = await fetch(`${SERVER_BASE_URL}/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal
    })

    if (!response.ok) return estimateTokenCount(content)
    const data = await response.json()
    return Array.isArray(data.tokens) ? data.tokens.length : estimateTokenCount(content)
  } catch (err) {
    if (isAbortError(err)) throw err
    return estimateTokenCount(content)
  }
}

const getPromptTokenCount = async (
  messages: Array<Pick<Message, 'content'>>,
  signal?: AbortSignal
): Promise<number> => {
  const content = messages
    .map((m) => {
      if (typeof m.content === 'string') return m.content
      if (Array.isArray(m.content)) {
        return m.content.map((c: MessageContentPart) => c.text || '').join('\n')
      }
      return ''
    })
    .join('\n\n')

  return getTextTokenCount(content, signal)
}

const applyGenerationStats = (
  promptTokens: number,
  reasoningTokens: number,
  responseTokens: number,
  startTime: number
): void => {
  stats.value.promptTokens = promptTokens
  stats.value.reasoningTokens = reasoningTokens
  stats.value.responseTokens = responseTokens
  stats.value.outputTokens = reasoningTokens + responseTokens
  stats.value.contextUsed = promptTokens + stats.value.outputTokens

  const elapsed = (Date.now() - startTime) / 1000
  stats.value.speed = elapsed > 0 ? stats.value.outputTokens / elapsed : 0
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
  const abortController = new AbortController()
  currentRequestController.value = abortController

  await nextTick()
  scrollToBottom(true)

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

    const promptTokens = await getPromptTokenCount(requestMessages, abortController.signal)
    const startTime = Date.now()
    applyGenerationStats(promptTokens, 0, 0, startTime)

    const response = await fetch(`${SERVER_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: requestMessages,
        stream: true,
        max_tokens: maxTokens.value,
        stream_options: { include_usage: true }
      }),
      signal: abortController.signal
    })

    if (!response.ok) {
      const errorText = await response.text()
      const detail = parseErrorDetail(errorText)
      throw new Error(detail ? `服务返回状态码 ${response.status}：${detail}` : `服务返回状态码 ${response.status}`)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('响应内容为空')

    const assistantMsg = {
      role: 'assistant',
      content: '',
      reasoning: '',
      reasoningExpanded: false
    } as Message
    messages.value.push(assistantMsg)
    const assistantMessage = messages.value[messages.value.length - 1]
    updateCurrentConversation()

    const streamTokenState = {
      promptTokens,
      reasoningText: '',
      responseText: '',
      version: 0,
      appliedVersion: 0,
      syncing: false,
      syncTimer: null as ReturnType<typeof setTimeout> | null
    }

    const syncStreamStats = async (force = false): Promise<void> => {
      if (streamTokenState.syncing) return
      if (!force && streamTokenState.version === streamTokenState.appliedVersion) return

      streamTokenState.syncing = true
      const targetVersion = streamTokenState.version
      const promptSnapshot = streamTokenState.promptTokens
      const reasoningSnapshot = streamTokenState.reasoningText
      const responseSnapshot = streamTokenState.responseText

      try {
        const [reasoningTokens, responseTokens] = await Promise.all([
          getTextTokenCount(reasoningSnapshot, abortController.signal),
          getTextTokenCount(responseSnapshot, abortController.signal)
        ])

        if (force || targetVersion >= streamTokenState.appliedVersion) {
          applyGenerationStats(promptSnapshot, reasoningTokens, responseTokens, startTime)
          streamTokenState.appliedVersion = targetVersion
        }
      } finally {
        streamTokenState.syncing = false
        if (streamTokenState.version !== streamTokenState.appliedVersion) {
          void syncStreamStats()
        }
      }
    }

    const scheduleStreamStatsSync = (): void => {
      if (streamTokenState.syncTimer) return
      streamTokenState.syncTimer = setTimeout(() => {
        streamTokenState.syncTimer = null
        void syncStreamStats()
      }, 120)
    }

    const consumeStreamEvent = (payload: string): void => {
      if (!payload || payload === '[DONE]') return

      const data = tryParseJson(payload) as ChatCompletionChunk | null
      const delta = data?.choices?.[0]?.delta
      const content = parseDeltaText(delta?.content)
      const reasoning = parseDeltaText(delta?.reasoning_content ?? delta?.reasoning)

      if (typeof data?.usage?.prompt_tokens === 'number') {
        streamTokenState.promptTokens = data.usage.prompt_tokens
      }

      if (reasoning && assistantMessage) {
        assistantMessage.reasoning = (assistantMessage.reasoning ?? '') + reasoning
        streamTokenState.reasoningText += reasoning
      }

      if (assistantMessage && typeof assistantMessage.content === 'string' && content) {
        assistantMessage.content += content
        streamTokenState.responseText += content
      }

      if (reasoning || content) {
        streamTokenState.version += 1
        scheduleStreamStatsSync()
      }

      scrollToBottom()
    }

    const decoder = new TextDecoder()
    let sseBuffer = ''
    while (true) {
      const { done, value } = await reader.read()
      sseBuffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })

      const events = sseBuffer.split('\n\n')
      sseBuffer = events.pop() ?? ''

      for (const event of events) {
        const payload = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('')
        consumeStreamEvent(payload)
      }

      if (done) {
        const payload = sseBuffer
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('')
        consumeStreamEvent(payload)
        break
      }
    }

    if (streamTokenState.syncTimer) {
      clearTimeout(streamTokenState.syncTimer)
      streamTokenState.syncTimer = null
    }
    if (streamTokenState.version > 0) {
      await syncStreamStats(true)
    } else {
      applyGenerationStats(streamTokenState.promptTokens, 0, 0, startTime)
    }
  } catch (err: unknown) {
    if (isAbortError(err)) {
      addLog('已停止生成')
      return
    }
    const msg = getErrorMessage(err)
    addLog(`发送消息失败：${msg}`)
    messages.value.push({ role: 'system', content: `错误：${msg}` })
  } finally {
    currentRequestController.value = null
    isGenerating.value = false
    updateCurrentConversation()
    scrollToBottom()
  }
}

const handleFileUpload = async (event: Event): Promise<void> => {
  const target = event.target as HTMLInputElement
  const files = Array.from(target.files ?? [])
  if (files.length === 0) return

  let addedCount = 0
  let skippedBinaryCount = 0
  let failedCount = 0

  try {
    for (const file of files) {
      try {
        const text = await file.text()
        if (text.slice(0, 1000).includes('\0')) {
          skippedBinaryCount++
          continue
        }
        attachedFiles.value.push(file)
        addedCount++
        addLog(`已添加文件：${file.name}`)
      } catch (err) {
        failedCount++
        addLog(`读取文件失败：${file.name}，${getErrorMessage(err)}`)
      }
    }

    if (skippedBinaryCount > 0) {
      addLog(`已跳过 ${skippedBinaryCount} 个二进制文件`)
    }
    if (failedCount > 0) {
      addLog(`有 ${failedCount} 个文件读取失败`)
    }
    if (addedCount === 0) {
      alert('没有可添加的文本文件')
    }
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
  contextSize.value = normalizeContextSize(contextSize.value)
  localStorage.setItem(CONTEXT_SIZE_STORAGE_KEY, contextSize.value.toString())
  localStorage.setItem(MAX_TOKENS_STORAGE_KEY, maxTokens.value.toString())
  showSettings.value = false
  if (serverStatus.value === 'running') {
    alert('设置已保存，注意：上下文长度的修改需要重启服务才能生效。')
  }
}

const isChatNearBottom = (): boolean => {
  if (!chatContainer.value) return true
  const { scrollTop, scrollHeight, clientHeight } = chatContainer.value
  return scrollHeight - scrollTop - clientHeight <= AUTO_SCROLL_THRESHOLD
}

const handleChatScroll = (): void => {
  shouldAutoScroll.value = isChatNearBottom()
}

const handleMessageImageLoad = (): void => {
  scrollToBottom()
}

const scrollToBottom = (force = false): void => {
  if (!chatContainer.value) return
  if (!force && !shouldAutoScroll.value) return
  chatContainer.value.scrollTop = chatContainer.value.scrollHeight
  shouldAutoScroll.value = true
}

const vFocus = {
  mounted: (el: HTMLElement) => el.focus()
}
</script>

<template>
  <div class="app-container">
    <div class="app-background">
      <div class="bg-orb orb-a"></div>
      <div class="bg-orb orb-b"></div>
      <div class="bg-grid"></div>
    </div>
    <div class="title-bar">
      <div class="app-title-area">
        <div class="app-brand-mark">OA</div>
        <div class="app-brand-copy">
          <span class="app-title">Office Assistant</span>
        </div>
        <span class="status-badge" :class="serverStatus">{{ statusLabel(serverStatus) }}</span>
      </div>
      <div class="title-stats-display title-stats-centered">
        <div class="title-stat-pill">
          <span class="title-stat-label">内存</span>
          <strong>{{ memoryUsagePercent }}%</strong>
        </div>
        <div v-if="systemStats.gpu.total > 0" class="title-stat-pill">
          <span class="title-stat-label">显存</span>
          <strong>{{ gpuUsagePercent }}%</strong>
        </div>
      </div>
    </div>
    <div class="sidebar">
      <div class="sidebar-model-card">
        <div v-if="modelPath" class="sidebar-model-name" :title="modelPath">
          {{ currentModelName }}
        </div>
        <div v-else class="sidebar-model-name is-placeholder">尚未选择模型</div>
      </div>
      <button class="new-chat-btn" @click="createConversation">
        <img :src="iconNewChat" alt="New Chat" />
        <span>开启新会话</span>
      </button>

      <div class="conversation-list sidebar-panel">
        <div class="sidebar-header">
          <div class="list-header">历史对话</div>
          <button class="icon-btn sidebar-settings-btn" @click="showSettings = true" title="设置">
            <img :src="iconSetting" alt="Settings" />
          </button>
        </div>
        <div 
          v-for="conv in conversations" 
          :key="conv.id" 
          class="conversation-item"
          :class="{ active: currentConversationId === conv.id, 'menu-open': showConversationMenuId === conv.id }"
          @click="selectConversation(conv.id)"
        >
          <div class="conversation-accent"></div>
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
          
          <button type="button" class="menu-btn" @click="(e) => toggleMenu(conv.id, e)" title="选项">
            <img :src="iconSelect" alt="Options" class="menu-btn-icon" />
          </button>

          <div v-if="showConversationMenuId === conv.id" class="conversation-menu">
            <button type="button" @click="(e) => startRenaming(conv.id, conv.title, e)">
               <img :src="iconRename" alt="Rename" />
               重命名
            </button>
            <button type="button" class="delete-item-btn" @click="(e) => deleteConversation(conv.id, e)">
               <img :src="iconDelete" alt="Delete" />
               删除
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="main-content">
      <Transition name="main-panel" mode="out-in">
        <div v-if="mainViewState === 'setup'" key="setup" class="launch-state">
          <div class="launch-state-card">
            <div class="launch-state-badge" :class="{ error: serverStatus === 'error' }">
              {{ serverStatus === 'error' ? '启动失败' : '未加载模型' }}
            </div>
            <div class="launch-controls">
              <div class="control-group-horizontal launch-control-group">
                <button class="control-btn" @click="selectModel">选择模型</button>
                <div v-if="modelPath" class="model-path-display launch-model-path" :title="modelPath">
                  {{ currentModelName }}
                </div>
                <div v-else class="model-path-display launch-model-path is-placeholder">尚未选择模型</div>
                <button class="control-btn primary-btn" :disabled="!modelPath" @click="startServer">
                  启动服务
                </button>
              </div>
            </div>
            <div v-if="serverStatus === 'error' && lastServerLog" class="launch-error-message">
              {{ lastServerLog }}
            </div>
          </div>
        </div>

        <div v-else-if="mainViewState === 'loading'" key="loading" class="launch-state launch-state-loading">
          <div class="launch-state-card loading-card">
            <div class="loading-spinner" aria-hidden="true"></div>
            <div class="launch-state-badge">加载中</div>
            <div v-if="modelPath" class="model-path-display launch-model-path loading-model-path" :title="modelPath">
              {{ currentModelName }}
            </div>
          </div>
        </div>

        <div v-else key="chat" class="chat-panel">
          <div ref="chatContainer" class="chat-area" @scroll="handleChatScroll">
            <div v-for="(msg, i) in messages" :key="i" class="message" :class="msg.role">
              <div class="message-header">
                <div class="message-role">{{ roleLabel(msg.role) }}</div>
              </div>
              <div class="message-content">
                <div v-if="msg.role === 'assistant' && msg.reasoning" class="reasoning-block">
                  <button type="button" class="reasoning-toggle" @click="toggleReasoning(i)">
                    <span class="reasoning-main">
                      <span class="reasoning-badge" :class="{ live: isReasoningStreaming(i) }">
                        <span class="reasoning-dot"></span>
                        <span class="reasoning-label">{{ reasoningLabel(i) }}</span>
                      </span>
                      <span class="reasoning-preview">{{ reasoningPreview(msg.reasoning, i) }}</span>
                    </span>
                    <span class="reasoning-arrow" :class="{ expanded: msg.reasoningExpanded }">⌄</span>
                  </button>
                  <div v-if="msg.reasoningExpanded" class="reasoning-text">{{ msg.reasoning }}</div>
                </div>

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
                    <div v-if="part.type === 'text'" class="message-text">{{ part.text }}</div>
                    <img
                      v-if="part.type === 'image_url'"
                      :src="part.image_url?.url"
                      class="message-image"
                      @load="handleMessageImageLoad"
                    />
                  </div>
                </template>
                <template v-else>
                  <div class="message-text">{{ msg.content }}</div>
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
                  Context: {{ stats.contextUsed }}/{{ contextSize }} ({{ contextUsagePercent }}%)
                </span>
                <span class="stat-item">
                  Output: {{ stats.outputTokens }}/{{ maxTokens === -1 ? '∞' : maxTokens }}
                  <template v-if="stats.reasoningTokens > 0">
                    · 思考 {{ stats.reasoningTokens }} / 回复 {{ stats.responseTokens }}
                  </template>
                </span>
                <span class="stat-item">
                  {{ stats.speed.toFixed(1) }} t/s
                </span>
              </div>

              <div class="composer-shell">
                <div class="input-area">
                  <textarea
                    ref="inputTextarea"
                    v-model="input"
                    placeholder="输入消息，Enter 发送，Shift+Enter 换行"
                    :disabled="serverStatus !== 'running' || isGenerating"
                    @keydown="handleInputKeydown"
                  ></textarea>

                  <input
                    ref="fileInput"
                    type="file"
                    multiple
                    style="display: none"
                    @change="handleFileUpload"
                  />
                  <input
                    ref="imageInput"
                    type="file"
                    accept="image/*"
                    style="display: none"
                    @change="handleImageUpload"
                  />

                  <div class="action-buttons">
                    <button
                      class="icon-btn"
                      title="上传文件"
                      :disabled="serverStatus !== 'running'"
                      @click="() => fileInput?.click()"
                    >
                      <img :src="iconFiles" alt="文件" />
                      <span>文件</span>
                    </button>
                    <button
                      v-if="supportsImages"
                      class="icon-btn"
                      title="上传图片"
                      :disabled="serverStatus !== 'running'"
                      @click="() => imageInput?.click()"
                    >
                      <img :src="iconPicture" alt="图片" />
                      <span>图片</span>
                    </button>
                  </div>

                  <button
                    class="send-btn"
                    :class="{ 'stop-generate-btn': isGenerating }"
                    :disabled="serverStatus !== 'running' && !isGenerating"
                    :title="isGenerating ? '停止生成' : '发送'"
                    @click="isGenerating ? stopGenerating() : sendMessage()"
                  >
                    <span v-if="isGenerating" class="stop-generate-icon" aria-hidden="true"></span>
                    <span v-else>发送</span>
                  </button>
                </div>
              </div>
            </div>
        </div>
      </Transition>
    </div>
    <div v-if="showSettings" class="settings-overlay">
      <div class="settings-modal">
        <div class="settings-header">
          <div>
            <span class="settings-kicker">Workspace</span>
            <h3>设置</h3>
          </div>
          <button class="settings-close" @click="showSettings = false">×</button>
        </div>
        <div class="setting-item">
          <label>上下文长度 (Context Size)</label>
          <div class="setting-desc">影响模型能记住的对话长度，修改后需重启服务。</div>
          <select v-model="contextSize">
            <option v-for="option in contextSizeOptions" :key="option.value" :value="option.value">
              {{ option.label }}<template v-if="option.value === 131072">（默认）</template>
            </option>
          </select>
        </div>

        <div class="setting-item">
          <label>最大输出 Token (Max Tokens)</label>
          <div class="setting-desc">限制单次回复的长度，设为 -1 表示不限制。</div>
          <input v-model="maxTokens" type="number" placeholder="-1" />
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
:root {
  color-scheme: light;
  --bg-base: #eef3fb;
  --bg-surface: rgba(255, 255, 255, 0.86);
  --bg-surface-strong: rgba(255, 255, 255, 0.96);
  --bg-surface-soft: rgba(248, 250, 252, 0.82);
  --border-soft: rgba(148, 163, 184, 0.22);
  --border-strong: rgba(99, 102, 241, 0.22);
  --shadow-soft: 0 14px 35px rgba(15, 23, 42, 0.07);
  --shadow-medium: 0 22px 50px rgba(15, 23, 42, 0.12);
  --text-primary: #0f172a;
  --text-secondary: #475569;
  --text-muted: #64748b;
  --brand: #4f46e5;
  --brand-strong: #4338ca;
  --brand-soft: rgba(79, 70, 229, 0.1);
  --success: #16a34a;
  --success-soft: rgba(22, 163, 74, 0.12);
  --warning: #f59e0b;
  --warning-soft: rgba(245, 158, 11, 0.14);
  --danger: #dc2626;
  --danger-soft: rgba(220, 38, 38, 0.12);
}

html,
body,
#app {
  height: 100%;
  margin: 0;
  padding: 0;
  font-family: 'Microsoft YaHei', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  overflow: hidden;
  background: var(--bg-base);
}

body {
  color: var(--text-primary);
}

button,
input,
select,
textarea {
  font: inherit;
}

button {
  padding: 10px 14px;
  border: none;
  border-radius: 14px;
  cursor: pointer;
  color: #ffffff;
  background: linear-gradient(135deg, var(--brand), #6366f1);
  transition:
    transform 0.16s ease,
    box-shadow 0.2s ease,
    background 0.2s ease,
    border-color 0.2s ease,
    color 0.2s ease;
}

button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 12px 24px rgba(79, 70, 229, 0.24);
}

button:active:not(:disabled) {
  transform: translateY(0);
}

button:disabled {
  cursor: not-allowed;
  color: #e2e8f0;
  background: #94a3b8;
  box-shadow: none;
}

textarea,
select,
input[type='number'],
.rename-input {
  border: 1px solid rgba(148, 163, 184, 0.34);
  background: rgba(255, 255, 255, 0.92);
  color: var(--text-primary);
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    background-color 0.2s ease;
}

textarea:focus,
select:focus,
input[type='number']:focus,
.rename-input:focus {
  outline: none;
  border-color: rgba(79, 70, 229, 0.52);
  box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.14);
}

.app-container {
  position: relative;
  display: flex;
  height: 100vh;
  width: 100vw;
  padding-top: 54px;
  box-sizing: border-box;
  color: var(--text-primary);
  background:
    radial-gradient(circle at top left, rgba(99, 102, 241, 0.18), transparent 28%),
    radial-gradient(circle at top right, rgba(14, 165, 233, 0.14), transparent 25%),
    linear-gradient(180deg, #f8fbff 0%, #eef3fb 100%);
}

.app-background {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.bg-orb {
  position: absolute;
  border-radius: 999px;
  filter: blur(12px);
  opacity: 0.9;
}

.orb-a {
  top: -90px;
  left: -120px;
  width: 320px;
  height: 320px;
  background: radial-gradient(circle, rgba(99, 102, 241, 0.22) 0%, rgba(99, 102, 241, 0) 72%);
}

.orb-b {
  right: -90px;
  top: 120px;
  width: 280px;
  height: 280px;
  background: radial-gradient(circle, rgba(56, 189, 248, 0.2) 0%, rgba(56, 189, 248, 0) 72%);
}

.bg-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(148, 163, 184, 0.07) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 163, 184, 0.07) 1px, transparent 1px);
  background-size: 32px 32px;
  mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.32), transparent 80%);
}

.title-bar {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 20;
  width: 100%;
  height: 54px;
  padding: 0 88px 0 16px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  -webkit-app-region: drag;
  background: rgba(248, 250, 252, 0.82);
  backdrop-filter: blur(18px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.72);
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06);
}

.app-title-area {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.app-brand-mark {
  width: 34px;
  height: 34px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: #ffffff;
  background: linear-gradient(135deg, #4338ca, #6366f1 55%, #0ea5e9);
  box-shadow: 0 12px 20px rgba(79, 70, 229, 0.22);
}

.app-brand-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.app-title {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: var(--text-primary);
}

.app-subtitle {
  font-size: 11px;
  color: var(--text-muted);
}

.title-stats-display {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  white-space: nowrap;
}

.title-stats-centered {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  justify-content: center;
  pointer-events: none;
}

.title-stat-pill {
  min-width: 92px;
  padding: 7px 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.72);
  background: rgba(255, 255, 255, 0.72);
  box-shadow: 0 10px 26px rgba(15, 23, 42, 0.06);
}

.title-stat-pill strong {
  font-size: 13px;
  color: var(--text-primary);
}

.title-stat-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
}

.status-badge {
  padding: 5px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  border: 1px solid transparent;
}

.status-badge.stopped {
  color: var(--text-secondary);
  background: rgba(100, 116, 139, 0.12);
  border-color: rgba(100, 116, 139, 0.16);
}

.status-badge.starting {
  color: #b45309;
  background: var(--warning-soft);
  border-color: rgba(245, 158, 11, 0.18);
}

.status-badge.running {
  color: #15803d;
  background: var(--success-soft);
  border-color: rgba(34, 197, 94, 0.18);
}

.status-badge.error {
  color: #b42318;
  background: var(--danger-soft);
  border-color: rgba(220, 38, 38, 0.16);
}

.sidebar {
  position: relative;
  z-index: 1;
  width: 240px;
  margin: 18px 0 18px 18px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.65);
  border-radius: 22px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(248, 250, 252, 0.82));
  box-shadow: var(--shadow-medium);
  backdrop-filter: blur(18px);
}

.sidebar-panel {
  border: 1px solid var(--border-soft);
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.7);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6);
}

.new-chat-btn {
  position: relative;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 12px 14px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.01em;
  overflow: hidden;
  background-clip: padding-box;
  background: linear-gradient(135deg, #4338ca 0%, #6366f1 55%, #0ea5e9 100%);
  border: 1px solid rgba(255, 255, 255, 0.24);
  box-shadow: 0 18px 30px rgba(79, 70, 229, 0.26);
}

.new-chat-btn:hover:not(:disabled) {
  box-shadow: 0 20px 38px rgba(79, 70, 229, 0.32);
}

.new-chat-btn img {
  width: 16px;
  height: 16px;
  filter: brightness(0) invert(1);
}

.sidebar-model-card {
  padding: 12px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.sidebar-model-name {
  max-width: 100%;
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-radius: 14px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(248, 250, 252, 0.9);
}

.sidebar-model-name.is-placeholder {
  color: #94a3b8;
}

.conversation-list {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  overflow-y: auto;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 4px;
}

.list-header {
  padding: 0 4px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.sidebar-settings-btn {
  min-width: 34px;
  width: 34px;
  height: 34px;
  padding: 0;
  flex-direction: row;
  flex: none;
  -webkit-app-region: no-drag;
}

.sidebar-settings-btn img {
  width: 16px;
  height: 16px;
  opacity: 0.72;
}

.conversation-item {
  position: relative;
  z-index: 0;
  display: flex;
  align-items: center;
  min-height: 52px;
  padding: 0 14px;
  border-radius: 16px;
  cursor: pointer;
  color: var(--text-primary);
  background: transparent;
  transition:
    transform 0.18s ease,
    background-color 0.18s ease,
    box-shadow 0.18s ease;
}

.conversation-item:hover {
  transform: translateY(-1px);
  background: rgba(99, 102, 241, 0.07);
}

.conversation-item.active {
  background: linear-gradient(135deg, rgba(79, 70, 229, 0.14), rgba(14, 165, 233, 0.09));
  box-shadow: inset 0 0 0 1px rgba(99, 102, 241, 0.16);
}

.conversation-item.menu-open {
  z-index: 40;
}

.conversation-accent {
  width: 6px;
  height: 30px;
  border-radius: 999px;
  margin-right: 12px;
  background: linear-gradient(180deg, rgba(99, 102, 241, 0), rgba(99, 102, 241, 0));
  transition: background 0.18s ease;
}

.conversation-item.active .conversation-accent {
  background: linear-gradient(180deg, #6366f1, #0ea5e9);
}

.conversation-title {
  flex: 1;
  min-width: 0;
  padding-right: 34px;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rename-input {
  flex: 1;
  width: 100%;
  padding: 8px 10px;
  border-radius: 12px;
  font-size: 13px;
}

.menu-btn {
  position: absolute;
  right: 8px;
  width: 32px;
  height: 32px;
  padding: 0;
  display: none;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.74);
  border: 1px solid rgba(148, 163, 184, 0.16);
  box-shadow: 0 8px 16px rgba(15, 23, 42, 0.08);
}

.conversation-item:hover .menu-btn,
.conversation-item.active .menu-btn,
.conversation-menu {
  display: flex;
}

.menu-btn:hover {
  background: rgba(255, 255, 255, 0.96);
}

.menu-btn-icon {
  width: 16px;
  height: 16px;
  opacity: 0.6;
}

.conversation-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 30;
  min-width: 134px;
  padding: 6px;
  flex-direction: column;
  pointer-events: auto;
  border-radius: 16px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.96);
  box-shadow: var(--shadow-medium);
  backdrop-filter: blur(16px);
}

.conversation-menu button {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  color: var(--text-primary);
  background: transparent;
  box-shadow: none;
}

.conversation-menu button:hover {
  color: #ffffff;
  background: linear-gradient(135deg, var(--brand), #6366f1);
}

.conversation-menu button img {
  width: 14px;
  height: 14px;
  opacity: 0.72;
}

.conversation-menu button:hover img {
  opacity: 1;
  filter: brightness(0) invert(1);
}

.delete-item-btn {
  color: var(--danger) !important;
}

.delete-item-btn:hover {
  background: linear-gradient(135deg, #ef4444, #dc2626) !important;
}

.conversation-list::-webkit-scrollbar,
.chat-area::-webkit-scrollbar {
  width: 8px;
}

.conversation-list::-webkit-scrollbar-track,
.chat-area::-webkit-scrollbar-track {
  background: transparent;
}

.conversation-list::-webkit-scrollbar-thumb,
.chat-area::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.38);
}

.conversation-list::-webkit-scrollbar-thumb:hover,
.chat-area::-webkit-scrollbar-thumb:hover {
  background: rgba(99, 102, 241, 0.36);
}

.main-content {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin: 18px 18px 18px 14px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.65);
  border-radius: 24px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.72), rgba(246, 249, 255, 0.82));
  box-shadow: var(--shadow-medium);
  backdrop-filter: blur(20px);
}

.control-group-horizontal {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.control-btn {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-primary);
  white-space: nowrap;
  border: 1px solid rgba(148, 163, 184, 0.2);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(248, 250, 252, 0.96));
  box-shadow: 0 8px 18px rgba(15, 23, 42, 0.06);
}

.control-btn:hover:not(:disabled) {
  color: var(--brand-strong);
  background: rgba(255, 255, 255, 0.98);
  box-shadow: 0 12px 22px rgba(79, 70, 229, 0.1);
}

.control-btn.primary-btn {
  color: #ffffff;
  background: linear-gradient(135deg, var(--brand), #6366f1);
  border-color: rgba(79, 70, 229, 0.2);
}

.control-btn.primary-btn:hover:not(:disabled) {
  box-shadow: 0 16px 28px rgba(79, 70, 229, 0.24);
}

.control-btn.stop-btn {
  background: linear-gradient(135deg, #ef4444, #dc2626);
  border-color: rgba(220, 38, 38, 0.24);
  color: #ffffff;
}

.control-btn.stop-btn:hover:not(:disabled) {
  box-shadow: 0 16px 28px rgba(220, 38, 38, 0.22);
}

.model-path-display {
  max-width: 320px;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-radius: 14px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(248, 250, 252, 0.9);
}

.model-path-display.is-placeholder {
  color: #94a3b8;
}

.chat-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px 12px 12px;
}

.chat-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 2px 10px;
  overflow-y: auto;
  background: transparent;
}

.message {
  max-width: min(76%, 860px);
  padding: 14px 16px;
  border-radius: 24px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  box-shadow: var(--shadow-soft);
}

.message-header {
  display: flex;
  align-items: center;
  margin-bottom: 8px;
}

.message-role {
  display: inline-flex;
  align-items: center;
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.message-content {
  font-size: 14px;
  line-height: 1.75;
  color: var(--text-primary);
}

.message.user {
  align-self: flex-end;
  background: linear-gradient(135deg, rgba(79, 70, 229, 0.14), rgba(14, 165, 233, 0.12));
}

.message.user .message-role {
  color: var(--brand-strong);
  background: rgba(79, 70, 229, 0.1);
}

.message.assistant {
  align-self: flex-start;
  background: rgba(255, 255, 255, 0.88);
}

.message.assistant .message-role {
  color: #0f766e;
  background: rgba(20, 184, 166, 0.1);
}

.message.system {
  align-self: center;
  max-width: min(86%, 760px);
  background: rgba(255, 247, 237, 0.92);
  border-color: rgba(251, 146, 60, 0.22);
}

.message.system .message-role {
  color: #c2410c;
  background: rgba(251, 146, 60, 0.12);
}

.message-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.message-image {
  max-width: min(100%, 520px);
  max-height: 360px;
  display: block;
  margin-top: 10px;
  border-radius: 18px;
  object-fit: contain;
  border: 1px solid rgba(148, 163, 184, 0.16);
  box-shadow: 0 12px 24px rgba(15, 23, 42, 0.08);
}

.message-files {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
}

.reasoning-block {
  margin-bottom: 12px;
  overflow: hidden;
  border-radius: 20px;
  border: 1px solid rgba(99, 102, 241, 0.1);
  background: linear-gradient(180deg, rgba(248, 250, 252, 0.92), rgba(255, 255, 255, 0.82));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
}

.reasoning-toggle {
  width: 100%;
  padding: 12px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  color: var(--text-secondary);
  background: transparent;
  box-shadow: none;
}

.reasoning-toggle:hover {
  background: rgba(99, 102, 241, 0.05);
  box-shadow: none;
}

.reasoning-main {
  min-width: 0;
  display: flex;
  flex: 1;
  align-items: center;
  gap: 10px;
}

.reasoning-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 7px 12px;
  border-radius: 999px;
  color: #4f46e5;
  background: rgba(99, 102, 241, 0.08);
  box-shadow: inset 0 0 0 1px rgba(99, 102, 241, 0.1);
}

.reasoning-badge.live {
  color: #0f766e;
  background: rgba(20, 184, 166, 0.1);
  box-shadow: inset 0 0 0 1px rgba(20, 184, 166, 0.12);
}

.reasoning-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.9;
}

.reasoning-badge.live .reasoning-dot {
  animation: reasoning-pulse 1.2s ease-in-out infinite;
}

.reasoning-label {
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.02em;
}

.reasoning-preview {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
  color: var(--text-secondary);
}

.reasoning-arrow {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: 999px;
  font-size: 16px;
  line-height: 1;
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.7);
  box-shadow: inset 0 0 0 1px rgba(148, 163, 184, 0.12);
  transition:
    transform 0.18s ease,
    background-color 0.18s ease,
    color 0.18s ease;
}

.reasoning-toggle:hover .reasoning-arrow {
  color: #4f46e5;
  background: rgba(255, 255, 255, 0.9);
}

.reasoning-arrow.expanded {
  transform: rotate(180deg);
}

.reasoning-text {
  padding: 12px 14px 14px;
  border-top: 1px solid rgba(99, 102, 241, 0.08);
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-secondary);
}

@keyframes reasoning-pulse {
  0%,
  100% {
    opacity: 0.45;
    transform: scale(0.9);
  }
  50% {
    opacity: 1;
    transform: scale(1.08);
  }
}

.input-container {
  padding-top: 0;
  background: transparent;
}

.composer-shell {
  padding: 10px 12px 12px;
  border: 1px solid rgba(148, 163, 184, 0.14);
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.88);
  box-shadow: var(--shadow-soft);
}

.file-preview-area {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 0 2px 12px;
}

.file-card {
  position: relative;
  display: flex;
  align-items: center;
  max-width: 250px;
  padding: 10px 12px;
  border-radius: 18px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  background: rgba(248, 250, 252, 0.9);
}

.file-icon {
  width: 38px;
  height: 38px;
  margin-right: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  background: rgba(79, 70, 229, 0.08);
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
  margin-right: 22px;
}

.file-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-size {
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-muted);
}

.remove-file-btn {
  position: absolute;
  top: 7px;
  right: 7px;
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 50%;
  color: var(--text-muted);
  background: transparent;
  box-shadow: none;
}

.remove-file-btn:hover {
  color: var(--text-primary);
  background: rgba(15, 23, 42, 0.06);
  box-shadow: none;
}

.image-preview {
  position: relative;
  align-self: flex-start;
  margin: 0 2px 12px;
  padding: 10px;
  border-radius: 22px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  background: rgba(248, 250, 252, 0.9);
  box-shadow: 0 10px 20px rgba(15, 23, 42, 0.06);
}

.image-preview img {
  display: block;
  height: 92px;
  border-radius: 14px;
}

.image-preview .close-btn {
  position: absolute;
  top: -8px;
  right: -8px;
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 999px;
  background: linear-gradient(135deg, #ef4444, #dc2626);
}

.input-area {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}

.action-buttons {
  display: flex;
  gap: 10px;
}

.icon-btn {
  min-width: 64px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-secondary);
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 18px;
  background: rgba(248, 250, 252, 0.95);
  box-shadow: 0 8px 18px rgba(15, 23, 42, 0.06);
}

.icon-btn:hover:not(:disabled) {
  color: var(--brand-strong);
  background: rgba(255, 255, 255, 0.98);
  box-shadow: 0 14px 22px rgba(79, 70, 229, 0.12);
}

.icon-btn img {
  width: 20px;
  height: 20px;
  object-fit: contain;
}

textarea {
  flex: 1;
  height: 82px;
  min-height: 44px;
  resize: none;
  padding: 12px 14px;
  border-radius: 16px;
  background: rgba(248, 250, 252, 0.95);
  line-height: 1.6;
}

.send-btn {
  min-width: 88px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  border-radius: 14px;
  box-shadow: 0 16px 26px rgba(79, 70, 229, 0.24);
}

.stop-generate-btn {
  width: 44px;
  min-width: 44px;
  padding: 0;
  border-radius: 14px;
  color: var(--text-primary);
  border: 1px solid rgba(148, 163, 184, 0.2);
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 10px 20px rgba(15, 23, 42, 0.08);
}

.stop-generate-btn:hover:not(:disabled) {
  border-color: rgba(220, 38, 38, 0.26);
  background: rgba(255, 255, 255, 1);
  box-shadow: 0 12px 22px rgba(220, 38, 38, 0.12);
}

.stop-generate-icon {
  position: relative;
  width: 18px;
  height: 18px;
  border: 1.5px solid #1f2937;
  border-radius: 999px;
}

.stop-generate-icon::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 7px;
  height: 7px;
  background: #1f2937;
  transform: translate(-50%, -50%);
}

.stats-bar {
  display: flex;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 0 2px 12px;
}

.stat-item {
  padding: 8px 12px;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.14);
  background: rgba(248, 250, 252, 0.9);
  font-size: 12px;
  color: var(--text-secondary);
  font-family: 'Consolas', 'Monaco', monospace;
}

.launch-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
}

.launch-state-card {
  width: min(780px, 100%);
  padding: 42px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  text-align: center;
  border-radius: 34px;
  border: 1px solid rgba(255, 255, 255, 0.72);
  background: rgba(255, 255, 255, 0.86);
  box-shadow: 0 28px 60px rgba(15, 23, 42, 0.12);
  backdrop-filter: blur(18px);
}

.launch-state-badge {
  padding: 7px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 800;
  color: var(--brand-strong);
  background: rgba(79, 70, 229, 0.1);
}

.launch-state-badge.error {
  color: #b42318;
  background: var(--danger-soft);
}

.launch-controls {
  width: 100%;
  margin-top: 6px;
}

.launch-control-group {
  width: 100%;
  justify-content: center;
}

.launch-model-path {
  max-width: 360px;
  text-align: left;
}

.loading-card {
  max-width: 520px;
}

.loading-model-path {
  margin-top: 6px;
}

.launch-error-message {
  width: 100%;
  padding: 14px 16px;
  border-radius: 18px;
  border: 1px solid rgba(220, 38, 38, 0.16);
  background: rgba(254, 242, 242, 0.94);
  color: #b42318;
  font-size: 13px;
  line-height: 1.7;
  text-align: left;
}

.loading-spinner {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 4px solid rgba(99, 102, 241, 0.16);
  border-top-color: var(--brand);
  animation: spin 0.9s linear infinite;
  box-shadow: 0 0 0 8px rgba(99, 102, 241, 0.06);
}

.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.26);
  backdrop-filter: blur(8px);
}

.settings-modal {
  width: min(460px, calc(100vw - 32px));
  padding: 26px;
  border-radius: 28px;
  border: 1px solid rgba(255, 255, 255, 0.72);
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 28px 56px rgba(15, 23, 42, 0.18);
}

.settings-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 24px;
}

.settings-kicker {
  display: inline-block;
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.settings-header h3 {
  margin: 0;
  font-size: 24px;
  color: var(--text-primary);
}

.settings-close {
  width: 38px;
  height: 38px;
  padding: 0;
  color: var(--text-secondary);
  border-radius: 14px;
  background: rgba(248, 250, 252, 1);
  border: 1px solid rgba(148, 163, 184, 0.16);
  box-shadow: none;
}

.settings-close:hover {
  color: var(--text-primary);
  background: rgba(241, 245, 249, 1);
  box-shadow: none;
}

.setting-item {
  margin-bottom: 18px;
  padding: 16px;
  border-radius: 20px;
  border: 1px solid rgba(148, 163, 184, 0.14);
  background: rgba(248, 250, 252, 0.84);
}

.setting-item label {
  display: block;
  margin-bottom: 8px;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
}

.setting-desc {
  margin-bottom: 10px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-muted);
}

.setting-item select,
.setting-item input {
  width: 100%;
  padding: 11px 12px;
  border-radius: 14px;
  box-sizing: border-box;
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 24px;
}

.settings-actions button {
  padding: 10px 18px;
}

.settings-actions button:first-child {
  color: var(--text-primary);
  background: rgba(248, 250, 252, 1);
  border: 1px solid rgba(148, 163, 184, 0.18);
  box-shadow: none;
}

.settings-actions button:first-child:hover {
  background: rgba(241, 245, 249, 1);
  box-shadow: none;
}

.controls-fade-enter-active,
.controls-fade-leave-active,
.main-panel-enter-active,
.main-panel-leave-active,
.input-fade-enter-active,
.input-fade-leave-active {
  transition:
    opacity 0.28s ease,
    transform 0.28s ease,
    filter 0.28s ease;
}

.controls-fade-enter-from,
.controls-fade-leave-to,
.input-fade-enter-from,
.input-fade-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

.main-panel-enter-from,
.main-panel-leave-to {
  opacity: 0;
  transform: translateY(18px) scale(0.99);
  filter: blur(4px);
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 1380px) {
  .model-path-display {
    max-width: 220px;
  }
}

@media (max-width: 1180px) {
  .sidebar {
    width: 220px;
  }
}

@media (max-width: 900px) {
  .app-container {
    padding-top: 50px;
  }

  .title-bar {
    height: 50px;
    padding: 0 74px 0 12px;
  }

  .title-stats-display {
    gap: 6px;
  }

  .sidebar {
    width: 210px;
    margin: 12px 0 12px 12px;
    padding: 12px;
    border-radius: 18px;
  }

  .main-content {
    margin: 12px;
    border-radius: 18px;
  }

  .launch-state {
    padding: 20px;
  }

  .launch-state-card {
    padding: 30px 22px;
    border-radius: 24px;
  }

  .launch-model-path {
    width: 100%;
    max-width: 100%;
  }

  .composer-shell {
    border-radius: 18px;
  }

  .message {
    max-width: 88%;
  }

  .input-area {
    flex-wrap: wrap;
  }

  textarea {
    width: 100%;
    order: 1;
  }

  .action-buttons {
    order: 2;
  }

  .send-btn {
    order: 3;
    margin-left: auto;
  }
}
</style>
