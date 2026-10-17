export type Edition = {
  id: "release" | "dev";
  productName: string;
  windowTitle: string;
  shortName: string;
  subtitle: string;
  identifier: string;
  installDirName: string;
  mark: string;
  markTone: "accent" | "dev";
  icons: string[];
};

declare const __NOVOARD_EDITION__: Edition;

/** 构建时写进前端包的版本宏。运行时只读这个对象。 */
export const edition: Edition = __NOVOARD_EDITION__;
