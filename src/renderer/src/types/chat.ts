export interface MessageContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: {
    url: string
  }
}

export interface AttachedFile {
  name: string
  size: number
  content: string
}

export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string | MessageContentPart[]
  files?: AttachedFile[]
  reasoning?: string
  reasoningExpanded?: boolean
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  updatedAt: number
}

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface ChatCompletionDeltaPart {
  text?: string
  content?: string
}

export interface ChatCompletionDelta {
  content?: string | ChatCompletionDeltaPart[]
  reasoning?: string | ChatCompletionDeltaPart[]
  reasoning_content?: string | ChatCompletionDeltaPart[]
}

export interface ChatCompletionUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export interface ChatCompletionChunk {
  choices?: Array<{
    delta?: ChatCompletionDelta
  }>
  usage?: ChatCompletionUsage
}
