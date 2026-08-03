export interface HelloEvent {
  type: 'hello';
  payload: Record<string, never>;
}

export interface ChatMessageEvent {
  type: 'chat.message';
  payload: {
    conversation_id: string;
    seq: number;
    sender_id: string;
  };
}

export interface ChatReadEvent {
  type: 'chat.read';
  payload: {
    conversation_id: string;
    user_id: string;
    last_read_seq: number;
  };
}

export type RealtimeEvent = HelloEvent | ChatMessageEvent | ChatReadEvent;

export function helloEvent(): HelloEvent {
  return { type: 'hello', payload: {} };
}

export function chatMessageEvent(payload: ChatMessageEvent['payload']): ChatMessageEvent {
  return { type: 'chat.message', payload };
}

export function chatReadEvent(payload: ChatReadEvent['payload']): ChatReadEvent {
  return { type: 'chat.read', payload };
}
