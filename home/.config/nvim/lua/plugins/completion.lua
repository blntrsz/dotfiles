return {
  'saghen/blink.cmp',
  dependencies = {
    'rafamadriz/friendly-snippets',
  },
  version = '1.*',

  ---@module 'blink.cmp'
  ---@type blink.cmp.Config
  opts = {
    keymap = {
      preset = 'none',
      ['<C-space>'] = { 'show', 'show_documentation', 'hide_documentation' },
      ['<C-e>'] = { 'cancel', 'fallback' },
      ['<CR>'] = { 'accept', 'fallback' },
      ['<C-y>'] = { 'accept', 'fallback' },

      ['<Up>'] = { 'select_prev', 'fallback' },
      ['<Down>'] = { 'select_next', 'fallback' },
      ['<C-p>'] = { 'select_prev', 'fallback_to_mappings' },
      ['<C-n>'] = { 'select_next', 'fallback_to_mappings' },

      ['<C-l>'] = { 'snippet_forward', 'fallback' },
      ['<C-h>'] = { 'snippet_backward', 'fallback' },
      ['<C-k>'] = { 'show_signature', 'hide_signature', 'fallback' },
    },
    signature = {
      enabled = true,
      window = { border = 'single' },
    },
    completion = {
      list = {
        selection = { preselect = true, auto_insert = true },
      },
      menu = {
        auto_show = function(ctx)
          return ctx.mode ~= 'cmdline'
        end,
      },
      documentation = { auto_show = true, auto_show_delay_ms = 50, window = { border = 'single' } },
    },

    appearance = {
      use_nvim_cmp_as_default = true,
      nerd_font_variant = 'mono',
    },

    sources = {
      default = { 'lazydev', 'lsp', 'path', 'snippets', 'buffer' },
      providers = {
        lazydev = {
          name = 'LazyDev',
          module = 'lazydev.integrations.blink',
          score_offset = 100,
        },
      },
    },
  },
  opts_extend = { 'sources.default' },
}
