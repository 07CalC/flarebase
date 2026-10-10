
export type Bindings = {

} & CloudflareBindings;


export type Variables = {
  JWT_SECRET: string;
  JWT_EXPIRY?: number;
}

export type HonoApp = {
  Bindings: Bindings;
  Variables: Variables;
}


