export type AccountData = {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
};

export interface ImageItem {
  url?: string;
  cdn_url?: string;
  thumb_url?: string;
  aeskey?: string;
  media?: {
    encrypt_query_param?: string;
    aes_key?: string;
    mid_size?: number;
    thumb_size?: number;
    thumb_height?: number;
    thumb_width?: number;
    hd_size?: number;
  };
}

export interface FileItem {
  url?: string;
  file_name?: string;
  file_size?: number;
  len?: string;
  media?: {
    encrypt_query_param?: string;
    aes_key?: string;
  };
}

export interface LinkItem {
  url?: string;
  title?: string;
  desc?: string;
}

export interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  image_item?: ImageItem;
  file_item?: FileItem;
  link_item?: LinkItem;
  ref_msg?: { message_item?: MessageItem; title?: string };
}

export interface WeixinMessage {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  create_time_ms?: number;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export type ExtractedContent =
  | { kind: "text"; text: string }
  | { kind: "image"; imageItem: ImageItem }
  | { kind: "file"; fileItem: FileItem; fileName: string }
  | null;

export interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

export interface TicketCacheEntry {
  ticket: string;
  nextFetchAt: number;
  retryDelayMs: number;
}

export interface ContextTokenEntry {
  token: string;
  updatedAt: number;
}
