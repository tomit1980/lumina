export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      activities: {
        Row: {
          actor_id: string | null
          conversation_id: string | null
          id: string
          kind: string
          project_id: string | null
          text: string
          ts: string
        }
        Insert: {
          actor_id?: string | null
          conversation_id?: string | null
          id: string
          kind: string
          project_id?: string | null
          text: string
          ts?: string
        }
        Update: {
          actor_id?: string | null
          conversation_id?: string | null
          id?: string
          kind?: string
          project_id?: string | null
          text?: string
          ts?: string
        }
        Relationships: [
          {
            foreignKeyName: "activities_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      attachments: {
        Row: {
          edited_at: string | null
          edited_by: string | null
          id: string
          mime: string
          name: string
          size: number
          storage_path: string
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          edited_at?: string | null
          edited_by?: string | null
          id: string
          mime?: string
          name: string
          size?: number
          storage_path: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          edited_at?: string | null
          edited_by?: string | null
          id?: string
          mime?: string
          name?: string
          size?: number
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "attachments_edited_by_fkey"
            columns: ["edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attachments_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_members: {
        Row: {
          channel_id: string
          level: string
          user_id: string
        }
        Insert: {
          channel_id: string
          level?: string
          user_id: string
        }
        Update: {
          channel_id?: string
          level?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_members_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      channels: {
        Row: {
          created_at: string
          created_by: string | null
          description: string
          id: string
          is_private: boolean
          is_team: boolean
          name: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string
          id: string
          is_private?: boolean
          is_team?: boolean
          name: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string
          id?: string
          is_private?: boolean
          is_team?: boolean
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "channels_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channels_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          id: string
          kind: string
        }
        Insert: {
          id: string
          kind: string
        }
        Update: {
          id?: string
          kind?: string
        }
        Relationships: []
      }
      dm_members: {
        Row: {
          dm_id: string
          user_id: string
        }
        Insert: {
          dm_id: string
          user_id: string
        }
        Update: {
          dm_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dm_members_dm_id_fkey"
            columns: ["dm_id"]
            isOneToOne: false
            referencedRelation: "dms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dm_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      dms: {
        Row: {
          created_at: string
          id: string
          pair_key: string | null
        }
        Insert: {
          created_at?: string
          id: string
          pair_key?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          pair_key?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dms_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      message_attachments: {
        Row: {
          attachment_id: string
          message_id: string
          source_project_id: string | null
        }
        Insert: {
          attachment_id: string
          message_id: string
          source_project_id?: string | null
        }
        Update: {
          attachment_id?: string
          message_id?: string
          source_project_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "message_attachments_attachment_id_fkey"
            columns: ["attachment_id"]
            isOneToOne: false
            referencedRelation: "attachments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_attachments_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_attachments_source_project_id_fkey"
            columns: ["source_project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          author_id: string | null
          content: string
          conversation_id: string
          created_at: string
          edited_at: string | null
          id: string
        }
        Insert: {
          author_id?: string | null
          content?: string
          conversation_id: string
          created_at?: string
          edited_at?: string | null
          id: string
        }
        Update: {
          author_id?: string | null
          content?: string
          conversation_id?: string
          created_at?: string
          edited_at?: string | null
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          color: string
          created_at: string
          email: string
          handle: string
          id: string
          mfa_required: boolean
          name: string
          role_id: string
          title: string
        }
        Insert: {
          color?: string
          created_at?: string
          email: string
          handle: string
          id: string
          mfa_required?: boolean
          name: string
          role_id: string
          title?: string
        }
        Update: {
          color?: string
          created_at?: string
          email?: string
          handle?: string
          id?: string
          mfa_required?: boolean
          name?: string
          role_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      project_attachments: {
        Row: {
          attachment_id: string
          project_id: string
        }
        Insert: {
          attachment_id: string
          project_id: string
        }
        Update: {
          attachment_id?: string
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_attachments_attachment_id_fkey"
            columns: ["attachment_id"]
            isOneToOne: false
            referencedRelation: "attachments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_attachments_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_members: {
        Row: {
          level: string
          project_id: string
          user_id: string
        }
        Insert: {
          level?: string
          project_id: string
          user_id: string
        }
        Update: {
          level?: string
          project_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_members_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          color: string
          created_at: string
          created_by: string | null
          description: string
          emoji: string
          id: string
          name: string
          priority: string
          restricted: boolean
        }
        Insert: {
          color?: string
          created_at?: string
          created_by?: string | null
          description?: string
          emoji?: string
          id: string
          name: string
          priority?: string
          restricted?: boolean
        }
        Update: {
          color?: string
          created_at?: string
          created_by?: string | null
          description?: string
          emoji?: string
          id?: string
          name?: string
          priority?: string
          restricted?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "projects_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      reactions: {
        Row: {
          emoji: string
          message_id: string
          user_id: string
        }
        Insert: {
          emoji: string
          message_id: string
          user_id: string
        }
        Update: {
          emoji?: string
          message_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reactions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      read_state: {
        Row: {
          conversation_id: string
          last_read_at: string
          user_id: string
        }
        Insert: {
          conversation_id: string
          last_read_at?: string
          user_id: string
        }
        Update: {
          conversation_id?: string
          last_read_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "read_state_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "read_state_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          color: string
          description: string
          id: string
          is_system: boolean
          locked: boolean
          name: string
          permissions: string[]
          rank: number
        }
        Insert: {
          color?: string
          description?: string
          id: string
          is_system?: boolean
          locked?: boolean
          name: string
          permissions?: string[]
          rank?: number
        }
        Update: {
          color?: string
          description?: string
          id?: string
          is_system?: boolean
          locked?: boolean
          name?: string
          permissions?: string[]
          rank?: number
        }
        Relationships: []
      }
      statuses: {
        Row: {
          color: string
          id: string
          is_done: boolean
          name: string
          position: number
        }
        Insert: {
          color?: string
          id: string
          is_done?: boolean
          name: string
          position?: number
        }
        Update: {
          color?: string
          id?: string
          is_done?: boolean
          name?: string
          position?: number
        }
        Relationships: []
      }
      task_attachments: {
        Row: {
          attachment_id: string
          task_id: string
        }
        Insert: {
          attachment_id: string
          task_id: string
        }
        Update: {
          attachment_id?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_attachments_attachment_id_fkey"
            columns: ["attachment_id"]
            isOneToOne: false
            referencedRelation: "attachments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_attachments_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_collaborators: {
        Row: {
          task_id: string
          user_id: string
        }
        Insert: {
          task_id: string
          user_id: string
        }
        Update: {
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_collaborators_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_collaborators_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          assignee_id: string | null
          created_at: string
          created_by: string | null
          description: string
          due_date: string | null
          duration_minutes: number | null
          id: string
          labels: string[]
          position: number
          priority: string
          project_id: string
          reminder_minutes: number | null
          start_time: string | null
          status: string
          title: string
        }
        Insert: {
          assignee_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string
          due_date?: string | null
          duration_minutes?: number | null
          id: string
          labels?: string[]
          position?: number
          priority?: string
          project_id: string
          reminder_minutes?: number | null
          start_time?: string | null
          status?: string
          title: string
        }
        Update: {
          assignee_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string
          due_date?: string | null
          duration_minutes?: number | null
          id?: string
          labels?: string[]
          position?: number
          priority?: string
          project_id?: string
          reminder_minutes?: number | null
          start_time?: string | null
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_status_fkey"
            columns: ["status"]
            isOneToOne: false
            referencedRelation: "statuses"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      actor_rank: { Args: never; Returns: number }
      attachment_of_object: { Args: { object_name: string }; Returns: string }
      can_join_dm: { Args: { target_dm_id: string }; Returns: boolean }
      can_see_attachment: { Args: { att_id: string }; Returns: boolean }
      can_see_conversation: { Args: { conv_id: string }; Returns: boolean }
      can_see_profile: { Args: { target_user_id: string }; Returns: boolean }
      can_see_project: { Args: { proj_id: string }; Returns: boolean }
      channel_is_manageable: {
        Args: { target_channel_id: string }
        Returns: boolean
      }
      dm_pair_key: { Args: { a: string; b: string }; Returns: string }
      find_or_create_dm: { Args: { other_user_id: string }; Returns: string }
      has_permission: { Args: { perm: string }; Returns: boolean }
      is_attachment_uploader: { Args: { att_id: string }; Returns: boolean }
      move_task: {
        Args: { p_index: number; p_status: string; p_task_id: string }
        Returns: undefined
      }
      my_role_id: { Args: never; Returns: string }
      orphaned_attachments: {
        Args: { older_than?: string }
        Returns: {
          id: string
          name: string
          storage_path: string
          uploaded_at: string
        }[]
      }
      project_is_manageable: {
        Args: { target_project_id: string }
        Returns: boolean
      }
      project_is_viewer_only: { Args: { proj_id: string }; Returns: boolean }
      session_is_assured: { Args: never; Returns: boolean }
      toggle_reaction: {
        Args: { emoji: string; message_id: string }
        Returns: Json
      }
      user_can_see_project: {
        Args: { project_id: string; user_id: string }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
