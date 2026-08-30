local library = { assert(os.getenv("NVIM_RUNTIME"), "NVIM_RUNTIME is required") .. "/lua" }
local lazy = os.getenv("NVIM_LAZY")

if lazy then
  library[#library + 1] = lazy
end

return {
  runtime = { version = "LuaJIT" },
  diagnostics = { globals = { "vim" } },
  workspace = { library = library },
}
