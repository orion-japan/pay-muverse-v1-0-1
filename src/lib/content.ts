export type Notice = { id: string; text: string };

export type HomeContent = {
  heroImages: string[]; // 複数枚スライダー対応
  notices: Notice[];
};

export interface ContentProvider {
  getHomeContent(): Promise<HomeContent>;
}
