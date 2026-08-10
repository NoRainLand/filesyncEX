/**
 * 控制台彩蛋 / 作者信息工具（从旧版 filesync/src/common/NiarApp.ts 移植）。
 * - NiarApp.init()：暴露 window.joke()（控制台冷笑话彩蛋）
 * - NiarApp.execute("me")：返回作者信息
 */
export class NiarApp {
  /** 冷笑话 API（旧版 ProjectConfig.jokeAPI，已内联） */
  private static readonly JOKE_API = "https://v2.jokeapi.dev/joke/Any";

  public static page: any = null;

  static init(page?: any): void {
    this.page = page ?? null;
    this.initJoke();
  }

  /** 添加一个 joke 接口 */
  static initJoke(): void {
    (<any>window).joke = () => {
      fetch(NiarApp.JOKE_API)
        .then((res) => res.json())
        .then((data: any) => {
          if (data.joke) {
            console.log(`%cJoke: %c${data.joke}`, `color: #ff0000;`, `color: #000000;`);
          } else if (data.setup && data.delivery) {
            console.log(`%cQ: %c${data.setup}`, `color: #ff0000;`, `color: #000000;`);
            console.log(`%cA: %c${data.delivery}`, `color: #ff0000;`, `color: #000000;`);
          } else {
            console.log("%cUnheihei: %cToday is so heihei that I don't want to tell you a joke.", `color: #ff0000;`, `color: #000000;`);
          }
        })
        .catch(() => {
          /* 网络失败静默 */
        });
      return "Joke is coming...";
    };
  }

  /**
   * aboutMe
   */
  public static execute(owner: string): any {
    if (owner === "me") {
      const name: string = "病雨";
      const age: number = NaN;
      const common_langs: string[] = ["HTML", "JS", "TS", "PY"];
      const interest: string[] = ["听歌", "电子游戏", "看小说", "看设定", "看涩图", "下厨"];
      const learning = ["unity3d", "Laya", "node.js", "blender"];
      const email: string = "d3V4aW5ydWZlbmdAcXEuY29t";
      const obj = {
        name,
        age,
        common_langs,
        interest,
        learning,
        email,
      };
      return obj;
    }
    return undefined;
  }
}
