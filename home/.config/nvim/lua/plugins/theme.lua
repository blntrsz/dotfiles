return {
  "Shatur/neovim-ayu",
  lazy = false,
  priority = 1000,
  opts = {},
  config = function()
    -- Ayu-dark palette for git gutter signs (applied on every colorscheme load)
    vim.api.nvim_create_autocmd("ColorScheme", {
      pattern = "*",
      callback = function()
        local green, yellow, red, grey = "#AAD94C", "#FFB454", "#F07178", "#5C6773"
        local groups = {
          GitSignsAdd          = green,
          GitSignsChange       = yellow,
          GitSignsDelete       = red,
          GitSignsTopdelete    = red,
          GitSignsChangedelete = yellow,
          GitSignsUntracked    = grey,
          GitSignsStagedAdd    = grey,
          GitSignsStagedChange = grey,
          GitSignsStagedDelete = grey,
        }
        for group, fg in pairs(groups) do
          vim.api.nvim_set_hl(0, group, { fg = fg, bg = "NONE" })
        end
        -- transparent sign column so signs blend with the buffer background
        vim.api.nvim_set_hl(0, "SignColumn", { bg = "NONE" })

        -- floating popups (gitsigns preview etc.): slightly lifted background + visible border
        vim.api.nvim_set_hl(0, "NormalFloat", { bg = "#111820" })
        vim.api.nvim_set_hl(0, "FloatBorder", { fg = "#4E5666", bg = "#111820" })
        vim.api.nvim_set_hl(0, "FloatTitle", { fg = "#FFB454", bg = "#111820" })

        -- subtle diff backgrounds inside gitsigns previews (instead of ayu's muddy Diff colors)
        vim.api.nvim_set_hl(0, "GitSignsAddPreview", { bg = "#1C2B1A" })
        vim.api.nvim_set_hl(0, "GitSignsDeletePreview", { bg = "#38212B" })
        vim.api.nvim_set_hl(0, "GitSignsChangePreview", { bg = "#33291A" })
        -- inline word-diff highlights
        vim.api.nvim_set_hl(0, "GitSignsAddInline", { fg = "#AAD94C", bg = "#2C4014" })
        vim.api.nvim_set_hl(0, "GitSignsDeleteInline", { fg = "#F07178", bg = "#4A2430" })

        -- blink.cmp popups: same lifted background + border as other floats
        vim.api.nvim_set_hl(0, "BlinkCmpMenu", { bg = "#111820" })
        vim.api.nvim_set_hl(0, "BlinkCmpMenuBorder", { fg = "#4E5666", bg = "#111820" })
        vim.api.nvim_set_hl(0, "BlinkCmpMenuSelection", { bg = "#26313F", fg = "#E6E1CF" })
        vim.api.nvim_set_hl(0, "BlinkCmpDocWindow", { bg = "#111820" })
        vim.api.nvim_set_hl(0, "BlinkCmpDocBorder", { fg = "#4E5666", bg = "#111820" })
        vim.api.nvim_set_hl(0, "BlinkCmpSignatureHelp", { bg = "#111820" })
        vim.api.nvim_set_hl(0, "BlinkCmpSignatureHelpBorder", { fg = "#4E5666", bg = "#111820" })
        vim.api.nvim_set_hl(0, "BlinkCmpKind", { fg = "#59C2FF" })
      end,
    })

    -- load the colorscheme here
    vim.cmd([[colorscheme ayu]])
  end,
}
