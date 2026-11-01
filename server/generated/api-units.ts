export const apiUnits = [
{
    id: "hello-world",
    name: "Hello World",
    method: "GET",
    path: "/api/hello",
    requestSchema: {},
    responseSchema: {"message":"string"},
    handler: async (
      request: Request,
      env: Record<string, unknown>,
      params: Record<string, string>,
    ) => {return { message: "Hello, world!" };
},
  }
];
