
export type Bindings = {

} & CloudflareBindings;


export type Variables = {
  auth?: {
    id: string;
    email?: string;
    isSuperUser: boolean;
  }
}

export type HonoApp = {
  Bindings: Bindings;
  Variables: Variables;
}


