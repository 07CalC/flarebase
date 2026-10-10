
export type Bindings = {

} & CloudflareBindings;


export type Variables = {
  auth?: {
    id: string;
    isSuperUser: boolean;
  }
}

export type HonoApp = {
  Bindings: Bindings;
  Variables: Variables;
}


