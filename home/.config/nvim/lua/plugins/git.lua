return {
  {
    "julienvincent/hunk.nvim",
    cmd = { "DiffEditor" },
    config = function()
      require("hunk").setup()
    end,
  },
  {
    "kdheepak/lazygit.nvim",
    keys = {
      { "<leader>gg", "<cmd>LazyGit<cr>" },
    },
  },
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
      require("gitsigns").setup()
    end,
  },
  {
    "esmuellert/codediff.nvim",
    cmd = "CodeDiff",
    opts = {
      diff = {
        layout = "inline",
      },
      keymaps = {
        view = {
          quit = false,
        },
      },
    },
    config = function(_, opts)
      require("codediff").setup(opts)

      local augroup = vim.api.nvim_create_augroup("config_codediff", { clear = true })
      vim.api.nvim_create_autocmd("User", {
        group = augroup,
        pattern = "CodeDiffOpen",
        callback = function(args)
          local tabpage = args.data and args.data.tabpage or vim.api.nvim_get_current_tabpage()
          require("config.codediff").map_quit(tabpage)
        end,
      })
    end,
    keys = {
      { "<leader>gd", "<cmd>CodeDiff<cr>", desc = "CodeDiff" },
    },
  },
  {
    "sindrets/diffview.nvim",
    config = function()
      require("diffview").setup()
    end,
  },
  {
    "NeogitOrg/neogit",
    dependencies = {
      "nvim-lua/plenary.nvim",
      "sindrets/diffview.nvim",
      "ibhagwan/fzf-lua",
    },
    config = true,
    keys = {
      { "<leader>ng", "<cmd>Neogit<cr>", desc = "Neogit" },
    }
  }
}
