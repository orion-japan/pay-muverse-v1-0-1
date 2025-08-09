export type Notice = { id: string; text: string };
export type HomeContent = { heroImage: string; notices: Notice[] };

export interface ContentProvider {
  getHomeContent(): Promise<HomeContent>;
}
