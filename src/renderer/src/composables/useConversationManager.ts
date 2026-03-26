import { ref, type Ref } from 'vue'
import { CONVERSATIONS_STORAGE_KEY, DEFAULT_CONVERSATION_TITLE } from '../constants/chat'
import type { Conversation, Message } from '../types/chat'

type ConversationManager = {
  conversations: Ref<Conversation[]>
  currentConversationId: Ref<string>
  messages: Ref<Message[]>
  loadConversations: () => void
  saveConversations: () => void
  selectConversation: (id: string) => void
  createConversation: () => void
  deleteConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  updateCurrentConversation: () => void
}

const createConversationId = (): string => {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

const getConversationTitleFromMessage = (message: Message): string => {
  if (typeof message.content === 'string') {
    return message.content.slice(0, 20) || DEFAULT_CONVERSATION_TITLE
  }

  const firstText = message.content.find((part) => part.type === 'text')?.text ?? ''
  return firstText.slice(0, 20) || DEFAULT_CONVERSATION_TITLE
}

export const useConversationManager = (): ConversationManager => {
  const conversations = ref<Conversation[]>([])
  const currentConversationId = ref('')
  const messages = ref<Message[]>([])

  const saveConversations = (): void => {
    localStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(conversations.value))
  }

  const loadConversations = (): void => {
    const saved = localStorage.getItem(CONVERSATIONS_STORAGE_KEY)
    if (!saved) return

    try {
      conversations.value = JSON.parse(saved) as Conversation[]
    } catch (error) {
      console.error('Failed to parse conversations', error)
      conversations.value = []
    }
  }

  const selectConversation = (id: string): void => {
    const conversation = conversations.value.find((item) => item.id === id)
    if (!conversation) return

    currentConversationId.value = id
    messages.value = [...conversation.messages]
    saveConversations()
  }

  const createConversation = (): void => {
    const conversation: Conversation = {
      id: createConversationId(),
      title: DEFAULT_CONVERSATION_TITLE,
      messages: [],
      updatedAt: Date.now()
    }

    conversations.value.unshift(conversation)
    selectConversation(conversation.id)
    saveConversations()
  }

  const deleteConversation = (id: string): void => {
    const index = conversations.value.findIndex((item) => item.id === id)
    if (index === -1) return

    conversations.value.splice(index, 1)
    saveConversations()

    if (currentConversationId.value !== id) return

    if (conversations.value.length > 0) {
      selectConversation(conversations.value[0].id)
      return
    }

    createConversation()
  }

  const renameConversation = (id: string, title: string): void => {
    const conversation = conversations.value.find((item) => item.id === id)
    if (!conversation) return

    conversation.title = title.trim() || DEFAULT_CONVERSATION_TITLE
    saveConversations()
  }

  const updateCurrentConversation = (): void => {
    const conversation = conversations.value.find((item) => item.id === currentConversationId.value)
    if (!conversation) return

    conversation.messages = [...messages.value]
    conversation.updatedAt = Date.now()

    if (conversation.title === DEFAULT_CONVERSATION_TITLE && messages.value.length > 0) {
      const firstMessage = messages.value[0]
      if (firstMessage.role === 'user') {
        conversation.title = getConversationTitleFromMessage(firstMessage)
      }
    }

    saveConversations()
  }

  return {
    conversations,
    currentConversationId,
    messages,
    loadConversations,
    saveConversations,
    selectConversation,
    createConversation,
    deleteConversation,
    renameConversation,
    updateCurrentConversation
  }
}
