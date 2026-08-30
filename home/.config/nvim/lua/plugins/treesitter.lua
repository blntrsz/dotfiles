local parsers = { 'javascript', 'typescript', 'tsx', 'css', 'html', 'markdown', 'markdown_inline' }
local filetypes = { 'javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'css', 'html', 'markdown' }

local function start_treesitter(buf)
  pcall(vim.treesitter.start, buf)
end

return {
  {
    'JoosepAlviste/nvim-ts-context-commentstring',
    opts = {
      enable_autocmd = false,
    },
  },
  {
    'nvim-treesitter/nvim-treesitter',
    branch = 'main',
    lazy = false,
    build = ':TSUpdate',
    init = function()
      vim.api.nvim_create_autocmd('FileType', {
        pattern = filetypes,
        callback = function(args)
          start_treesitter(args.buf)
        end,
      })
    end,
    config = function()
      require('nvim-treesitter').install(parsers)
    end,
  },
  {
    'numToStr/Comment.nvim',
    config = function()
      require('Comment').setup {
        pre_hook = require('ts_context_commentstring.integrations.comment_nvim').create_pre_hook(),
      }
    end,
  },
}
