local servers = {
  "tsc",
  "lua_ls",
  "jsonls",
  "yamlls",
  "tailwindcss",
}

return {
  {
    "williamboman/mason.nvim",
    config = function()
      require("mason").setup { PATH = "prepend" }
    end,
  },
  {
    "neovim/nvim-lspconfig",
    dependencies = {
      "saghen/blink.cmp",
    },
    config = function()
      vim.lsp.config("*", {
        capabilities = require("blink.cmp").get_lsp_capabilities(),
      })

      vim.lsp.enable(servers)
    end,
  },
}
