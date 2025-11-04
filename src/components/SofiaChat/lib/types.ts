export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  uploaded_image_urls?: string[];
  isPreview?: boolean;
}

export interface PostMessageParams {
  query: string;
  user: string; // user_code
  conversation_id?: string;
  response_mode?: 'blocking' | 'streaming';
  inputs?: Record<string, any>;
  files?: Array<{
    type: 'image' | 'file';
    transfer_method: 'local_file';
    upload_file_id: string;
  }>;
}
