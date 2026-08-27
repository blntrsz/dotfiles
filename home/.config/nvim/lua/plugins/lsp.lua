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
      require("mason").setup({ PATH = "prepend" })
    end,
  },
  {
    'neovim/nvim-lspconfig',
    dependencies = {
      'williamboman/mason-lspconfig.nvim',
      'saghen/blink.cmp',
      'copilotlsp-nvim/copilot-lsp',
    },
    config = function()
      vim.lsp.config('*', {
        capabilities = require('blink.cmp').get_lsp_capabilities(),
      })

      vim.lsp.enable(servers)
    end
  }
}
