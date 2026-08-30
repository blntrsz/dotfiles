return {
  {
    "lewis6991/gitsigns.nvim",
    lazy = false,
    keys = {
      { "<leader>gp",  "<cmd>Gitsigns preview_hunk<cr>", desc = "Preview hunk" },
      { "<leader>gb",  "<cmd>Gitsigns blame_line<cr>",   desc = "Blame line" },
      { "<leader>gr",  "<cmd>Gitsigns reset_hunk<cr>",   desc = "Reset hunk" },
      { "<leader>ghs", "<cmd>Gitsigns stage_hunk<cr>",   desc = "Stage Hunk" },
    },
    config = function()
      local bar = "▎"
      require("gitsigns").setup({
        signs = {
          add          = { text = bar },
          change       = { text = bar },
          delete       = { text = "▁" },
          topdelete    = { text = "▔" },
          changedelete = { text = bar },
          untracked    = { text = "┆" },
        },
        signs_staged = {
          add          = { text = bar },
          change       = { text = bar },
          delete       = { text = "▁" },
          topdelete    = { text = "▔" },
          changedelete = { text = bar },
        },
        preview_config = {
          border = "rounded",
          style = "minimal",
          relative = "cursor",
          row = 0,
          col = 1,
        },
      })
    end,
  },
  {
    "NeogitOrg/neogit",
    dependencies = {
      "nvim-lua/plenary.nvim",
    },
    config = true,
    keys = {
      { "<leader>ng", "<cmd>Neogit<cr>", desc = "Neogit" },
    }
  }
}
