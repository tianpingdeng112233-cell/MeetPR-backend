declare module 'ali-oss' {
  interface Options {
    accessKeyId: string;
    accessKeySecret: string;
    bucket: string;
    region: string;
    endpoint: string;
  }

  type OSSConstructor = new (options: Options) => unknown;
  const OSS: OSSConstructor;

  export = OSS;
}
